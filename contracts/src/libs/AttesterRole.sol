// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @title AttesterRole
/// @notice The attester is the off-chain key (spec 9.2) that attests "this human passed KYC". MVP: raw
///         EOA key in Secret Manager (ATTESTER_PK); KMS signing is the production path.
///         It is the only writer of Identity.register and Identity.rotateAccount. The deployer can
///         rotate the attester address; nobody else can. There is no other privileged role here.
abstract contract AttesterRole {
    address internal _attester;
    address public immutable deployer;

    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    error NotAttester();
    error NotDeployer();
    error ZeroAddress();

    constructor(address attester_) {
        if (attester_ == address(0)) revert ZeroAddress();
        deployer = msg.sender;
        _attester = attester_;
        emit AttesterChanged(address(0), attester_);
    }

    function attester() public view virtual returns (address) {
        return _attester;
    }

    modifier onlyAttester() {
        if (msg.sender != _attester) revert NotAttester();
        _;
    }

    function setAttester(address newAttester) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (newAttester == address(0)) revert ZeroAddress();
        address previous = _attester;
        _attester = newAttester;
        emit AttesterChanged(previous, newAttester);
    }
}
