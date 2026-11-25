// Sources flattened with hardhat v2.29.2 https://hardhat.org

// SPDX-License-Identifier: Apache-2.0

// File contracts/QoreVest.sol

// Original license: SPDX_License_Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title QoreVest
/// @notice An EVM token (QVEST) with time-based vesting, for the QoreChain
///         Developer Fest Cross-VM category (qorechain-diana testnet).
/// @dev HOW THE CROSS-VM LEG WORKS
///      Every claim is a single atomic EVM transaction with two legs:
///        (1) EVM leg: vested QVEST is transferred to the beneficiary.
///        (2) Native leg: this contract calls the cross-VM bridge precompile
///            (0x0901) to grant the beneficiary a vesting allowance on the
///            approved Native cw20 contract (WDT), equal to the claimed
///            amount. The allowance is owned by this contract, so the
///            Native contract holds a cross-VM vesting ledger whose
///            invariant anyone can verify off-chain:
///                allowance(QoreVest, beneficiary) == total claimed.
///      If the Native call fails, the whole transaction reverts: no QVEST
///      moves and no vesting state changes (atomic execution, verified by
///      the chain's journaling of the nested call).
///
///      HONEST LIMITATIONS (see README for the full discussion):
///      - The vesting SCHEDULE (cliff, linear release) is enforced by this
///        EVM contract, not by the Native contract: no vesting contract is
///        on the bridge allowlist (the three allowlisted targets are a cw20
///        test token and two instances of a third-party tournament
///        contract). The Native leg is a vesting ledger/attestation, not
///        the schedule enforcer.
///      - The WDT vault is unfunded on this testnet (the whole WDT supply
///        is held by its deployer), so the Native allowance is an
///        attestation of vested amounts, not a spendable release. The
///        QVEST release itself happens on the EVM leg in the same tx.
///      - The beneficiary's Native (bech32) address is verified on-chain
///        against msg.sender, so allowances can never be misdirected.
///
///      WINDOW NOTE: a user calling claim() needs only a NORMAL EVM
///      authorisation window. The chain's window check applies to the
///      transaction's recipient (this contract); the internal precompile
///      call is admitted with it. (A direct EOA call to the precompile
///      needs a scoped window listing 0x0901 — see scripts/window.ts.)
contract QoreVest {
    // ------------------------------------------------------------------
    // Token (QVEST, 6 decimals — the same as WDT, so claimed QVEST and the
    // Native allowance are 1:1 in base units).
    // ------------------------------------------------------------------
    string public constant name = "QoreVest";
    string public constant symbol = "QVEST";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ------------------------------------------------------------------
    // Vesting
    // ------------------------------------------------------------------
    struct Schedule {
        uint256 total; // total QVEST locked in this schedule
        uint256 claimed; // QVEST claimed so far
        uint256 start; // unix timestamp the schedule starts
        uint256 cliff; // seconds after start before anything vests
        uint256 duration; // seconds of linear vesting after the cliff
        bool exists;
    }

    mapping(address => Schedule) public schedules;
    address[] public beneficiaries;
    uint256 public totalLocked;

    event VestingCreated(
        address indexed beneficiary,
        uint256 total,
        uint256 start,
        uint256 cliff,
        uint256 duration
    );
    event Claimed(
        address indexed beneficiary,
        uint256 amount,
        uint256 totalClaimed,
        string nativeSpender
    );
    event CrossVmMirrored(address indexed beneficiary, bytes reply);

    // ------------------------------------------------------------------
    // Cross-VM
    // ------------------------------------------------------------------
    /// @notice The cross-VM bridge precompile (0x0901 on Diana; a mock in tests).
    address public immutable crossVmPrecompile;
    /// @notice The approved Native contract (WDT cw20 address on Diana).
    string public nativeTarget;
    /// @notice The issuer: may create vesting schedules, nothing else.
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not the owner");
        _;
    }

    constructor(address _crossVmPrecompile, string memory _nativeTarget, uint256 _initialSupply) {
        require(_crossVmPrecompile != address(0), "zero precompile");
        require(bytes(_nativeTarget).length > 0, "empty native target");
        require(_initialSupply > 0, "zero supply");
        crossVmPrecompile = _crossVmPrecompile;
        nativeTarget = _nativeTarget;
        owner = msg.sender;
        totalSupply = _initialSupply;
        balanceOf[address(this)] = _initialSupply;
        emit Transfer(address(0), address(this), _initialSupply);
    }

    // ------------------------------------------------------------------
    // ERC-20 subset
    // ------------------------------------------------------------------
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance exceeded");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "zero recipient");
        require(balanceOf[from] >= value, "insufficient balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    // ------------------------------------------------------------------
    // Vesting
    // ------------------------------------------------------------------
    /// @notice Create a vesting schedule for a beneficiary (owner only).
    /// @dev One schedule per beneficiary. Tokens stay in the contract; the
    ///      schedule is a promise against them, tracked by totalLocked.
    function createVesting(
        address beneficiary,
        uint256 amount,
        uint256 start,
        uint256 cliffDuration,
        uint256 duration
    ) external onlyOwner {
        require(beneficiary != address(0), "zero beneficiary");
        require(amount > 0, "zero amount");
        require(duration > 0, "zero duration");
        require(!schedules[beneficiary].exists, "schedule exists");
        require(totalLocked + amount <= balanceOf[address(this)], "exceeds unallocated supply");
        schedules[beneficiary] = Schedule({
            total: amount,
            claimed: 0,
            start: start,
            cliff: cliffDuration,
            duration: duration,
            exists: true
        });
        beneficiaries.push(beneficiary);
        totalLocked += amount;
        emit VestingCreated(beneficiary, amount, start, cliffDuration, duration);
    }

    /// @notice How much of a beneficiary's schedule has vested by now.
    function vested(address beneficiary) public view returns (uint256) {
        Schedule storage s = schedules[beneficiary];
        if (!s.exists) return 0;
        uint256 cliffEnd = s.start + s.cliff;
        if (block.timestamp < cliffEnd) return 0;
        if (block.timestamp >= cliffEnd + s.duration) return s.total;
        return (s.total * (block.timestamp - cliffEnd)) / s.duration;
    }

    /// @notice How much a beneficiary can claim right now.
    function claimable(address beneficiary) public view returns (uint256) {
        Schedule storage s = schedules[beneficiary];
        if (!s.exists) return 0;
        return vested(beneficiary) - s.claimed;
    }

    /// @notice Claim all currently vested QVEST, atomically mirrored to the
    ///         Native vesting ledger.
    /// @param nativeSpender The caller's Native (bech32 `qor1...`) address,
    ///        verified on-chain to decode to msg.sender. It becomes the
    ///        spender of the Native allowance for the claimed amount.
    /// @return amount The QVEST claimed.
    function claim(string calldata nativeSpender) external returns (uint256 amount) {
        Schedule storage s = schedules[msg.sender];
        require(s.exists, "no schedule");
        amount = claimable(msg.sender);
        require(amount > 0, "nothing claimable");
        // Bind the Native address to the caller: the bech32 payload must
        // decode to exactly msg.sender's 20 bytes, with a valid checksum.
        require(_bech32ToAddress(nativeSpender) == msg.sender, "native address mismatch");

        // Effects (checks-effects-interactions): move QVEST first, then the
        // cross-VM call. If the Native call fails, everything reverts.
        s.claimed += amount;
        totalLocked -= amount;
        balanceOf[address(this)] -= amount;
        balanceOf[msg.sender] += amount;
        emit Transfer(address(this), msg.sender, amount);
        emit Claimed(msg.sender, amount, s.claimed, nativeSpender);

        bytes memory payload = abi.encodePacked(
            '{"increase_allowance":{"spender":"',
            nativeSpender,
            '","amount":"',
            _toString(amount),
            '"}}'
        );
        bytes memory reply = _callNative(nativeTarget, payload);
        emit CrossVmMirrored(msg.sender, reply);
    }

    /// @notice Call an approved Native contract through the bridge precompile.
    /// @return reply The target's raw reply bytes.
    function _callNative(string memory target, bytes memory payload) internal returns (bytes memory reply) {
        bytes memory data = abi.encodeWithSignature(
            "executeCrossVMCall(uint8,string,bytes)",
            uint8(1),
            target,
            payload
        );
        (bool ok, bytes memory ret) = crossVmPrecompile.call(data);
        require(ok, "cross-VM call failed");
        // Since chain v3.2.5 the precompile returns abi.encode(bytes): an
        // active precompile always returns at least 64 bytes, so a shorter
        // reply means the precompile is inactive (call succeeded, did
        // nothing) and must be treated as a failure.
        require(ret.length >= 64, "cross-VM precompile not active or empty reply");
        reply = abi.decode(ret, (bytes));
    }

    // ------------------------------------------------------------------
    // Bech32 (BIP-173) verification for `qor1...` addresses.
    // ------------------------------------------------------------------
    /// @notice Decode a `qor1...` bech32 address to its 20-byte account.
    /// @dev Verifies the human-readable part ("qor"), the length (42 chars:
    ///      "qor1" + 32 data chars + 6 checksum chars), the checksum
    ///      (polymod == 1), and converts the 5-bit groups to 20 bytes.
    ///      Reverts on any malformed input.
    function _bech32ToAddress(string calldata addr) internal pure returns (address) {
        bytes memory b = bytes(addr);
        require(b.length == 42, "bad bech32 length");
        require(b[0] == "q" && b[1] == "o" && b[2] == "r" && b[3] == "1", "bad bech32 prefix");
        // 5-bit values of the 38 data+checksum chars.
        uint8[38] memory vals;
        for (uint256 i = 0; i < 38; i++) {
            vals[i] = _bech32Value(b[4 + i]);
        }
        // Checksum: polymod over hrpExpand("qor") + data must equal 1.
        require(_bech32Polymod(vals) == 1, "bad bech32 checksum");
        // Convert the first 32 5-bit groups to 20 bytes (160 bits, no padding).
        bytes memory out = new bytes(20);
        uint256 acc;
        uint256 bits;
        uint256 o;
        for (uint256 i = 0; i < 32; i++) {
            acc = (acc << 5) | vals[i];
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = bytes1(uint8(acc >> bits));
            }
        }
        require(o == 20, "bad bech32 payload");
        return address(bytes20(out));
    }

    function _bech32Value(bytes1 c) internal pure returns (uint8) {
        bytes memory charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        for (uint8 i = 0; i < 32; i++) {
            if (charset[i] == c) return i;
        }
        revert("bad bech32 char");
    }

    function _bech32Polymod(uint8[38] memory vals) internal pure returns (uint256) {
        uint256[5] memory gen = [
            uint256(0x3b6a57b2),
            uint256(0x26508e6d),
            uint256(0x1ea119fa),
            uint256(0x3d4233dd),
            uint256(0x2a1462b3)
        ];
        uint256 chk = 1;
        // hrpExpand("qor"): [3, 3, 3, 0, 17, 15, 18] (high bits, separator, low bits).
        uint8[7] memory hrp = [uint8(3), 3, 3, 0, 17, 15, 18];
        for (uint256 i = 0; i < 7; i++) {
            chk = _polymodStep(chk, hrp[i], gen);
        }
        for (uint256 i = 0; i < 38; i++) {
            chk = _polymodStep(chk, vals[i], gen);
        }
        return chk;
    }

    function _polymodStep(uint256 chk, uint256 v, uint256[5] memory gen) internal pure returns (uint256) {
        uint256 top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (uint256 i = 0; i < 5; i++) {
            if ((top >> i) & 1 == 1) {
                chk ^= gen[i];
            }
        }
        return chk;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
