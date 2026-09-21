// SPDX-License-Identifier: MIT
// Coinbase's wallet pins `pragma solidity 0.8.23`, so this script compiles in that unit rather than
// the repo's 0.8.31 one. See the note in foundry.toml.
pragma solidity 0.8.23;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {CoinbaseSmartWalletFactory} from "smart-wallet/CoinbaseSmartWalletFactory.sol";

/// @title DeployCoinbaseFactory
/// @notice Spec 8.2: attendee, gate and admin accounts are all Coinbase Smart Wallets, and every one
///         of them is created by a single factory. This puts that factory on the chain and records it
///         in `deployments/<chainid>.json`, which is where sub-plans 02 and 03 read it from.
///
/// @dev    Three outcomes, in order of preference:
///
///         1. Coinbase's own factory is already on the chain at the mainnet address. Then MONTI uses
///            it and deploys nothing: the ecosystem's account addresses and ours agree, and sub-plan
///            03's `toCoinbaseSmartAccount` runs on its stock configuration.
///         2. Our own build is already there from an earlier run. The CREATE2 deployer reverts on a
///            repeat, so the script adopts what it finds instead of trying again -- reruns are free.
///         3. Nothing is there. Deploy the implementation, then the factory that proxies to it, both
///            through the canonical CREATE2 deployer with a zero salt so the addresses fall out of
///            the init code alone and can be recomputed by anyone.
///
///         In case 3 the addresses will almost certainly differ from mainnet, and that is expected
///         rather than a failure. An address matches only when bytecode, salt and deployer all match,
///         and Coinbase built with solc 0.8.23 at 999_999 optimizer runs through the IR pipeline with
///         an IPFS metadata hash, deployed from the Safe singleton factory. This repo builds at 200
///         runs with `bytecode_hash = "none"`. The script logs the difference and carries on, because
///         nothing downstream hardcodes the factory -- everything reads the JSON this writes.
///
///         Inputs come from the environment only, so no key is ever written into this repository:
///           DEPLOYER_PK  broadcast key. Always required, including on the two paths that deploy
///                        nothing -- a script that sometimes needs a key and sometimes does not is
///                        worse to operate than one that always asks for it.
contract DeployCoinbaseFactory is Script {
    /// @notice Arachnid's deterministic deployment proxy, present on Monad testnet and preloaded by
    ///         forge, which makes the deployed address a function of the init code and nothing else.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Coinbase Smart Wallet v1 on Ethereum mainnet and every chain Coinbase has deployed to.
    address public constant MAINNET_IMPLEMENTATION = 0x000100abaad02f1cfC8Bbe32bD5a564817339E72;
    address public constant MAINNET_FACTORY = 0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a;

    bytes32 public constant SALT = bytes32(0);

    /// @notice Where the implementation and factory ended up: deployed, adopted, or already ours.
    address public implementationAddress;
    address public factoryAddress;

    /// @notice Where this repo's build of each lands under CREATE2 -- computable before any
    ///         transaction, and the same on every chain.
    address public predictedImplementation;
    address public predictedFactory;

    /// @notice True when Coinbase's own factory was found at the mainnet address and used as is.
    bool public adoptedCanonical;

    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        resolve();
        vm.stopBroadcast();

        _log();
        record();
    }

    /// @notice Adopts or deploys the factory, whichever the chain calls for.
    /// @dev    Separate from `run`, and free of both the broadcast and the key, so the tests can
    ///         drive it directly. That is not only tidiness: `vm.setEnv` writes the real process
    ///         environment and forge runs test suites in parallel, so a suite here that set
    ///         DEPLOYER_PK would overwrite the one Deploy.t.sol is running on.
    function resolve() public {
        bytes memory implementationInitCode = type(CoinbaseSmartWallet).creationCode;
        predictedImplementation = vm.computeCreate2Address(SALT, keccak256(implementationInitCode), CREATE2_DEPLOYER);

        // The factory takes the implementation as a constructor argument, so its init code -- and
        // therefore its address -- follows from where the implementation lands.
        bytes memory factoryInitCode =
            abi.encodePacked(type(CoinbaseSmartWalletFactory).creationCode, abi.encode(predictedImplementation));
        predictedFactory = vm.computeCreate2Address(SALT, keccak256(factoryInitCode), CREATE2_DEPLOYER);

        if (_isLiveFactory(MAINNET_FACTORY)) {
            adoptedCanonical = true;
            factoryAddress = MAINNET_FACTORY;
            implementationAddress = CoinbaseSmartWalletFactory(MAINNET_FACTORY).implementation();
            return;
        }

        adoptedCanonical = false;
        if (predictedImplementation.code.length > 0 && predictedFactory.code.length > 0) {
            implementationAddress = predictedImplementation;
            factoryAddress = predictedFactory;
            return;
        }

        require(CREATE2_DEPLOYER.code.length > 0, "no CREATE2 deployer on this chain");
        implementationAddress = _create2(implementationInitCode, predictedImplementation);
        factoryAddress = _create2(factoryInitCode, predictedFactory);
    }

    /// @dev Deploys `initCode` through the CREATE2 deployer unless `predicted` already holds code, in
    ///      which case that code is this same init code by construction and redeploying would revert.
    function _create2(bytes memory initCode, address predicted) private returns (address deployed) {
        if (predicted.code.length > 0) return predicted;

        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
        require(ok, "create2 failed");
        deployed = address(uint160(bytes20(ret)));
        require(deployed == predicted, "deployed somewhere other than predicted");
        require(deployed.code.length > 0, "no code at deployed address");
    }

    /// @dev A factory worth adopting is one that answers `implementation()` with a contract. Comparing
    ///      runtime code against our own build would prove nothing -- ours is compiled differently and
    ///      would never match Coinbase's byte for byte -- whereas this is the property sub-plan 03
    ///      actually depends on.
    function _isLiveFactory(address candidate) private view returns (bool) {
        if (candidate.code.length == 0) return false;

        (bool ok, bytes memory ret) = candidate.staticcall(abi.encodeWithSignature("implementation()"));
        if (!ok || ret.length != 32) return false;

        return abi.decode(ret, (address)).code.length > 0;
    }

    function _log() private view {
        console2.log("implementation ", implementationAddress);
        console2.log("factory        ", factoryAddress);

        if (adoptedCanonical) {
            console2.log("Coinbase's own factory was already deployed here; adopted it, deployed nothing");
            return;
        }
        if (factoryAddress == MAINNET_FACTORY && implementationAddress == MAINNET_IMPLEMENTATION) {
            console2.log("addresses match mainnet");
            return;
        }
        console2.log("WARNING: addresses differ from mainnet; sub-plans 02 and 03 must read the JSON below");
        console2.log("mainnet implementation", MAINNET_IMPLEMENTATION);
        console2.log("mainnet factory       ", MAINNET_FACTORY);
    }

    /// @notice Records the factory where sub-plans 02 and 03 look for it.
    /// @dev    `Deploy.s.sol` writes the other keys of this file and carries `coinbaseFactory` over;
    ///         this is the mirror of that, so the two scripts can run in either order without either
    ///         one erasing the other's addresses. Public for the same reason `resolve` is.
    function record() public {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory existing = vm.exists(path) ? vm.readFile(path) : "{}";

        string memory obj = "monti";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "identity", _carryAddress(existing, ".identity"));
        vm.serializeAddress(obj, "organizers", _carryAddress(existing, ".organizers"));
        vm.serializeAddress(obj, "ticket", _carryAddress(existing, ".ticket"));
        vm.serializeAddress(obj, "paymaster", _carryAddress(existing, ".paymaster"));
        vm.serializeAddress(obj, "attester", _carryAddress(existing, ".attester"));
        vm.serializeAddress(obj, "coinbaseFactory", factoryAddress);
        vm.serializeAddress(obj, "entryPoint", _carryAddress(existing, ".entryPoint"));
        string memory out = vm.serializeUint(obj, "block", _carryUint(existing, ".block"));

        vm.writeJson(out, path);
        console2.log("wrote", path);
    }

    function _carryAddress(string memory json, string memory key) private view returns (address) {
        return vm.keyExistsJson(json, key) ? vm.parseJsonAddress(json, key) : address(0);
    }

    function _carryUint(string memory json, string memory key) private view returns (uint256) {
        return vm.keyExistsJson(json, key) ? vm.parseJsonUint(json, key) : 0;
    }
}
