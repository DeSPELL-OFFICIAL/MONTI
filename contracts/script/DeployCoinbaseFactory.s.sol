// SPDX-License-Identifier: MIT
// Coinbase's wallet pins `pragma solidity 0.8.23`, so this script compiles in that unit rather than
// the repo's 0.8.31 one. See the note in foundry.toml.
pragma solidity 0.8.23;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
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
///         1. Coinbase's own factory is already on the chain, at either of the two addresses they
///            have shipped -- v1 or v1.1. Then MONTI uses it and deploys nothing: the ecosystem's
///            account addresses and ours agree, and sub-plan 03's `toCoinbaseSmartAccount` runs on
///            its stock configuration. v1 is preferred when both are present, because that is the
///            factory permissionless.js defaults to.
///         2. Our own build is already there from an earlier run. The CREATE2 deployer reverts on a
///            repeat, so the script adopts what it finds instead of trying again -- reruns are free.
///         3. Nothing is there. Deploy the implementation, then the factory that proxies to it, both
///            through the canonical CREATE2 deployer with a zero salt so the addresses fall out of
///            the init code alone and can be recomputed by anyone.
///
///         In case 3 the addresses cannot be Coinbase's, and that is by construction rather than a
///         failure. An address matches only when bytecode, salt and deployer all match, and the brief
///         mandates `salt = bytes32(0)` and the Arachnid deployer where `lib/smart-wallet`'s own
///         `script/DeployFactory.s.sol` uses two non-zero salts and the Safe singleton factory. The
///         bytecode differs on top of that (Coinbase build at 999_999 optimizer runs through the IR
///         pipeline with an IPFS metadata hash; this repo at 200 runs with `bytecode_hash = "none"`).
///         No build setting closes that gap, so the script says so once and carries on -- nothing
///         downstream hardcodes the factory, everything reads the JSON this writes.
///
///         Inputs come from the environment only, so no key is ever written into this repository:
///           DEPLOYER_PK  broadcast key. Always required, including on the two paths that deploy
///                        nothing -- a script that sometimes needs a key and sometimes does not is
///                        worse to operate than one that always asks for it.
contract DeployCoinbaseFactory is Script {
    /// @notice Arachnid's deterministic deployment proxy, present on Monad testnet and preloaded by
    ///         forge, which makes the deployed address a function of the init code and nothing else.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Coinbase Smart Wallet v1, the same address on every chain Coinbase has deployed to.
    ///         Listed first because this is the factory permissionless.js's `toCoinbaseSmartAccount`
    ///         defaults to, so it is the one sub-plan 03 gets for free.
    address public constant MAINNET_IMPLEMENTATION = 0x000100abaad02f1cfC8Bbe32bD5a564817339E72;
    address public constant MAINNET_FACTORY = 0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a;

    /// @notice Coinbase Smart Wallet v1.1, which is what `lib/smart-wallet` is actually pinned at
    ///         (`v1.1.0-7-ga4e83fd`). Both addresses come from that tree's own deploy script,
    ///         `lib/smart-wallet/script/DeployFactory.s.sol`, and its README's deployment table.
    ///         Without this pair the adopt path would walk straight past a real Coinbase deployment.
    address public constant MAINNET_IMPLEMENTATION_V1_1 = 0x00000110dCdEdC9581cb5eCB8467282f2926534d;
    address public constant MAINNET_FACTORY_V1_1 = 0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842;

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

        // A dry run simulates the deployment but changes nothing on chain, so recording its
        // addresses would overwrite the tracked record with contracts that do not exist. Only a
        // real broadcast earns the write; the tests call `record()` themselves.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) record();
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

        address canonical = _liveCanonicalFactory();
        if (canonical != address(0)) {
            adoptedCanonical = true;
            factoryAddress = canonical;
            implementationAddress = CoinbaseSmartWalletFactory(canonical).implementation();
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
        // The deployer returns exactly 20 bytes, and a short or malformed return cannot pass
        // unnoticed: the next line requires the result to be the address predicted from this very
        // init code, which no truncation would produce.
        // forge-lint: disable-next-line(unsafe-typecast)
        deployed = address(uint160(bytes20(ret)));
        require(deployed == predicted, "deployed somewhere other than predicted");
        require(deployed.code.length > 0, "no code at deployed address");
    }

    /// @dev v1 before v1.1: both are real Coinbase deployments, but permissionless.js defaults to v1,
    ///      so preferring it keeps sub-plan 03 on stock configuration.
    function _liveCanonicalFactory() private view returns (address) {
        if (_isLiveFactory(MAINNET_FACTORY)) return MAINNET_FACTORY;
        if (_isLiveFactory(MAINNET_FACTORY_V1_1)) return MAINNET_FACTORY_V1_1;
        return address(0);
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

        // Not a warning to act on: `salt = bytes32(0)` and the Arachnid deployer are this script's
        // mandate, and Coinbase used two non-zero salts and the Safe singleton factory, so no build
        // setting reaches their addresses. Said once, plainly, so nobody goes looking.
        console2.log("this is MONTI's own factory, not Coinbase's -- read it from the JSON below");
        console2.log("parity is unreachable by construction: salt and deployer differ from Coinbase's");
        console2.log("Coinbase v1.0 factory ", MAINNET_FACTORY);
        console2.log("Coinbase v1.1 factory ", MAINNET_FACTORY_V1_1);
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
