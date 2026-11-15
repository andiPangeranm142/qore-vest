// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title CrossVmCaller (research probe — NOT the QoreVest app contract)
/// @notice Minimal contract to answer one question before the QoreVest design
///         is finalised: when a CONTRACT calls the cross-VM precompile, who
///         does the Native (CosmWasm) contract see as the sender — the calling
///         contract's mapped address, or the EVM transaction's origin?
/// @dev Calls executeCrossVMCall(1, WDT, increase_allowance) through the
///      precompile at 0x0901 and returns the decoded reply. The allowance
///      owner observed on the Native side afterwards answers the question.
///      The caller passes the spender as a bech32 string (Solidity has no
///      bech32 encoder here); the contract only builds the JSON payload.
contract CrossVmCaller {
    address constant CROSS_VM_PRECOMPILE = 0x0000000000000000000000000000000000000901;

    /// @notice The approved Native cw20 contract (WDT) on Diana testnet.
    string public constant WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";

    /// @notice Emitted after a cross-VM call returns.
    event CrossVmCalled(bytes reply);

    /// @notice Call the precompile with an arbitrary payload for a target.
    /// @return reply The target's raw reply bytes (decoded from abi.encode(bytes)).
    function callNative(string memory target, bytes memory payload) public returns (bytes memory reply) {
        bytes memory data = abi.encodeWithSignature(
            "executeCrossVMCall(uint8,string,bytes)",
            uint8(1),
            target,
            payload
        );
        (bool ok, bytes memory ret) = CROSS_VM_PRECOMPILE.call(data);
        require(ok, "cross-VM call failed");
        // Since chain v3.2.5 the precompile returns abi.encode(bytes): an
        // active precompile always returns at least 64 bytes, so a shorter
        // reply means the precompile is inactive (call succeeded, did nothing).
        require(ret.length >= 64, "cross-VM precompile not active or empty reply");
        reply = abi.decode(ret, (bytes));
        emit CrossVmCalled(reply);
    }

    /// @notice Grant a WDT allowance via the bridge (test probe).
    /// @param spenderBech32 The spender's qor1 address (must differ from the sender).
    /// @param amount The allowance amount in uWDT, as a decimal string.
    function grantAllowance(string calldata spenderBech32, string calldata amount)
        external
        returns (bytes memory reply)
    {
        bytes memory payload = abi.encodePacked(
            '{"increase_allowance":{"spender":"',
            spenderBech32,
            '","amount":"',
            amount,
            '"}}'
        );
        return callNative(WDT, payload);
    }
}
