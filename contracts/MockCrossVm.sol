// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title MockCrossVm
/// @notice Test-only stand-in for the cross-VM bridge precompile (0x0901).
/// @dev Implements the same function the precompile decodes —
///      executeCrossVMCall(uint8,string,bytes) (selector 0x3c11078c) — and
///      mimics the chain v3.2.5+ reply format: abi.encode(bytes). Records
///      every call so tests can assert the target and the JSON payload, and
///      can be told to fail the next call to test atomicity (a Native
///      failure must revert the whole EVM transaction).
contract MockCrossVm {
    bool public failNext;
    uint8 public lastTargetVm;
    string public lastTarget;
    bytes public lastPayload;
    uint256 public callCount;

    event Called(uint8 targetVm, string target, bytes payload);

    function setFailNext(bool f) external {
        failNext = f;
    }

    function executeCrossVMCall(uint8 targetVm, string calldata target, bytes calldata payload)
        external
        returns (bytes memory)
    {
        lastTargetVm = targetVm;
        lastTarget = target;
        lastPayload = payload;
        callCount += 1;
        emit Called(targetVm, target, payload);
        if (failNext) {
            failNext = false;
            revert("mock: native call failed");
        }
        return abi.encode(bytes('{"ok":true}'));
    }
}
