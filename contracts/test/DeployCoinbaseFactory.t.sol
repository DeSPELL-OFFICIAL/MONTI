// SPDX-License-Identifier: MIT
// Coinbase's wallet pins `pragma solidity 0.8.23`, so everything that imports it -- the script and
// this test -- compiles in that unit rather than the repo's 0.8.31 one. See foundry.toml.
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {CoinbaseSmartWalletFactory} from "smart-wallet/CoinbaseSmartWalletFactory.sol";
import {DeployCoinbaseFactory} from "../script/DeployCoinbaseFactory.s.sol";

/// @notice Spec 8.2: every MONTI account -- attendee, gate and admin -- is a Coinbase Smart Wallet,
///         so sub-plan 03 cannot create a single account until this factory exists on Monad testnet.
///         What is proved here is what a dry run cannot show: the factory really is reachable at the
///         address CREATE2 predicts from its init code, it points at the implementation this script
///         deployed, the account addresses it predicts are stable, and recording it into
///         `deployments/<chainid>.json` leaves every key `Deploy.s.sol` wrote in place.
/// @dev    Everything runs through the script object in process: `resolve()` and `record()` are the
///         whole of `run()` minus the broadcast, and neither reads DEPLOYER_PK. That matters --
///         `vm.setEnv` writes the real process environment and forge runs suites in parallel, so a
///         suite that set it would overwrite the key Deploy.t.sol is running on.
contract DeployCoinbaseFactoryTest is Test {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Only ever used to derive an owner address; never written to the environment.
    uint256 internal constant OWNER_PK = 0xC0173A5E;

    /// @dev Stands in for what `Deploy.s.sol` writes into the same file before this script runs.
    ///      One distinct address per key, so a merge that crossed two of them would be caught.
    address internal constant IDENTITY = 0x000000000000000000000000000000000000000A;
    address internal constant ORGANIZERS = 0x000000000000000000000000000000000000000b;
    address internal constant TICKET = 0x000000000000000000000000000000000000000C;
    address internal constant PAYMASTER = 0x000000000000000000000000000000000000000d;
    address internal constant ATTESTER = 0x000000000000000000000000000000000000000E;
    address internal constant ENTRY_POINT = 0x000000000000000000000000000000000000000F;
    uint256 internal constant DEPLOY_BLOCK = 77;

    string internal constant SEEDED_BY_DEPLOY_SCRIPT = '{"chainId":31338,'
        '"identity":"0x000000000000000000000000000000000000000a",'
        '"organizers":"0x000000000000000000000000000000000000000b",'
        '"ticket":"0x000000000000000000000000000000000000000c",'
        '"paymaster":"0x000000000000000000000000000000000000000d",'
        '"attester":"0x000000000000000000000000000000000000000e",'
        '"coinbaseFactory":"0x0000000000000000000000000000000000000000",'
        '"entryPoint":"0x000000000000000000000000000000000000000f",' '"block":77}';

    DeployCoinbaseFactory internal script;
    address internal owner;

    function setUp() public {
        // Same guard as Deploy.t.sol: pin the chain id so a forked run can never write the tracked
        // deployments/10143.json.
        vm.chainId(31337);
        script = new DeployCoinbaseFactory();
        owner = vm.addr(OWNER_PK);
    }

    function test_deploysThroughTheCanonicalCreate2Deployer() public {
        assertTrue(CREATE2_DEPLOYER.code.length > 0, "forge preloads the canonical CREATE2 deployer");

        script.resolve();

        assertTrue(script.implementationAddress().code.length > 0, "implementation has code");
        assertTrue(script.factoryAddress().code.length > 0, "factory has code");
        assertEq(script.implementationAddress(), script.predictedImplementation(), "implementation is reproducible");
        assertEq(script.factoryAddress(), script.predictedFactory(), "factory is reproducible from its init code");
        assertFalse(script.adoptedCanonical(), "nothing was on chain to adopt");
    }

    function test_factoryPointsAtTheImplementationItWasGiven() public {
        script.resolve();

        CoinbaseSmartWalletFactory factory = CoinbaseSmartWalletFactory(script.factoryAddress());
        assertEq(factory.implementation(), script.implementationAddress(), "factory.implementation()");
    }

    /// @notice Sub-plan 03 shows an attendee their address before the first sponsored operation pays
    ///         to deploy it, so the prediction has to be the address `createAccount` actually lands on.
    function test_predictedAccountAddressIsWhereCreateAccountLands() public {
        script.resolve();
        CoinbaseSmartWalletFactory factory = CoinbaseSmartWalletFactory(script.factoryAddress());

        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(owner);

        address predicted = factory.getAddress(owners, 0);
        assertEq(predicted, factory.getAddress(owners, 0), "prediction is stable");
        assertEq(predicted.code.length, 0, "and costs nothing until it is used");

        CoinbaseSmartWallet account = factory.createAccount(owners, 0);
        assertEq(address(account), predicted, "createAccount lands on the predicted address");
        assertTrue(account.isOwnerAddress(owner), "with the owner it was created for");

        // A different nonce is a different account; the same nonce is the same one, already deployed.
        assertTrue(factory.getAddress(owners, 1) != predicted, "nonce separates accounts");
        assertEq(address(factory.createAccount(owners, 0)), predicted, "re-creating is a no-op");
    }

    /// @notice CREATE2 through the canonical deployer reverts on a repeat, so a second run of the
    ///         script has to recognise its own deployment rather than try again.
    function test_secondRunAdoptsWhatTheFirstRunDeployed() public {
        script.resolve();
        address factory = script.factoryAddress();
        address implementation = script.implementationAddress();

        script.resolve();

        assertEq(script.factoryAddress(), factory, "same factory");
        assertEq(script.implementationAddress(), implementation, "same implementation");
    }

    /// @notice If Coinbase's own factory is already on the chain, MONTI must use it -- that is the
    ///         whole point of the mainnet addresses, and deploying a second factory next to it would
    ///         give every attendee a different account address than the rest of the ecosystem.
    function test_adoptsTheCanonicalV1FactoryWhenItIsAlreadyOnChain() public {
        address canonicalImplementation = _etchCanonicalAt(script.MAINNET_FACTORY(), script.MAINNET_IMPLEMENTATION());

        script.resolve();

        assertTrue(script.adoptedCanonical(), "adopted rather than deployed");
        assertEq(script.factoryAddress(), script.MAINNET_FACTORY(), "the v1 factory address");
        assertEq(script.implementationAddress(), canonicalImplementation, "its own implementation");
        assertEq(script.predictedFactory().code.length, 0, "nothing was deployed alongside it");
    }

    /// @notice lib/smart-wallet is pinned at v1.1.0-7-ga4e83fd, so v1.1 is the deployment Coinbase
    ///         would most likely already have on a new chain. Checking only the v1 pair would walk
    ///         straight past it and deploy a redundant factory.
    function test_adoptsTheCanonicalV1_1FactoryWhenItIsAlreadyOnChain() public {
        address canonicalImplementation =
            _etchCanonicalAt(script.MAINNET_FACTORY_V1_1(), script.MAINNET_IMPLEMENTATION_V1_1());

        script.resolve();

        assertTrue(script.adoptedCanonical(), "adopted rather than deployed");
        assertEq(script.factoryAddress(), script.MAINNET_FACTORY_V1_1(), "the v1.1 factory address");
        assertEq(script.implementationAddress(), canonicalImplementation, "its own implementation");
        assertEq(script.predictedFactory().code.length, 0, "nothing was deployed alongside it");
    }

    /// @notice With both on chain, v1 wins: permissionless.js's `toCoinbaseSmartAccount` defaults to
    ///         the v1 factory, so adopting it is what keeps sub-plan 03 on stock configuration.
    function test_prefersTheV1FactoryWhenBothAreOnChain() public {
        _etchCanonicalAt(script.MAINNET_FACTORY(), script.MAINNET_IMPLEMENTATION());
        _etchCanonicalAt(script.MAINNET_FACTORY_V1_1(), script.MAINNET_IMPLEMENTATION_V1_1());

        script.resolve();

        assertEq(script.factoryAddress(), script.MAINNET_FACTORY(), "v1 is preferred");
    }

    /// @notice The canonical addresses are only Coinbase's on the chains Coinbase deployed to. On any
    ///         other chain they are anybody's to take, and a squatter that answers `implementation()`
    ///         with its own contract would pass a liveness check that asked for nothing more. Adopting
    ///         it would point every MONTI account at a factory the rest of the ecosystem has never
    ///         heard of, so the script deploys its own instead.
    function test_ignoresASquatterAtTheCanonicalAddresses() public {
        address impostor = _etchImpostorFactoryAt(script.MAINNET_FACTORY());
        _etchImpostorFactoryAt(script.MAINNET_FACTORY_V1_1());

        script.resolve();

        assertFalse(script.adoptedCanonical(), "a live contract at the address is not Coinbase's factory");
        assertEq(script.factoryAddress(), script.predictedFactory(), "MONTI deployed its own instead");
        assertTrue(script.factoryAddress().code.length > 0, "and it is really on chain");
        assertTrue(impostor != script.MAINNET_IMPLEMENTATION(), "the squatter's implementation is its own");
    }

    /// @notice The two constants are a pair. A factory at the v1 address that proxies to the v1.1
    ///         implementation is not the v1 deployment -- account addresses follow from factory and
    ///         implementation together -- so recognising the implementation alone is not enough.
    function test_doesNotAdoptACanonicalAddressCrossedWithTheOtherVersionsImplementation() public {
        CoinbaseSmartWallet realImplementation = new CoinbaseSmartWallet();
        vm.etch(script.MAINNET_IMPLEMENTATION_V1_1(), address(realImplementation).code);

        CoinbaseSmartWalletFactory crossed = new CoinbaseSmartWalletFactory(script.MAINNET_IMPLEMENTATION_V1_1());
        vm.etch(script.MAINNET_FACTORY(), address(crossed).code);

        script.resolve();

        assertFalse(script.adoptedCanonical(), "the v1 factory has to report the v1 implementation");
        assertEq(script.factoryAddress(), script.predictedFactory(), "MONTI deployed its own instead");
    }

    /// @notice `Deploy.s.sol` and this script write the same file from opposite ends. Whichever runs
    ///         second must leave the other's addresses alone, or sub-plan 02 loses its contracts or
    ///         sub-plan 03 loses its account factory.
    function test_recordKeepsEveryKeyTheDeployScriptWrote() public {
        // Its own chain id: forge runs test suites in parallel and Deploy.t.sol owns 31337.json.
        vm.chainId(31338);
        string memory path = "deployments/31338.json";
        vm.writeFile(path, SEEDED_BY_DEPLOY_SCRIPT);

        script.resolve();
        script.record();

        string memory raw = vm.readFile(path);
        assertEq(vm.parseJsonAddress(raw, ".coinbaseFactory"), script.factoryAddress(), "coinbaseFactory");
        assertEq(vm.parseJsonUint(raw, ".chainId"), 31338, "chainId");
        assertEq(vm.parseJsonAddress(raw, ".identity"), IDENTITY, "identity survived");
        assertEq(vm.parseJsonAddress(raw, ".organizers"), ORGANIZERS, "organizers survived");
        assertEq(vm.parseJsonAddress(raw, ".ticket"), TICKET, "ticket survived");
        assertEq(vm.parseJsonAddress(raw, ".paymaster"), PAYMASTER, "paymaster survived");
        assertEq(vm.parseJsonAddress(raw, ".attester"), ATTESTER, "attester survived");
        assertEq(vm.parseJsonAddress(raw, ".entryPoint"), ENTRY_POINT, "entryPoint survived");
        assertEq(vm.parseJsonUint(raw, ".block"), DEPLOY_BLOCK, "block survived");

        vm.removeFile(path);
    }

    /// @notice Run before `Deploy.s.sol` has ever run, the file still has to come out with every key
    ///         sub-plans 02 and 03 read, so nothing downstream has to handle a missing field.
    function test_recordCreatesTheFileWhenNothingHasWrittenItYet() public {
        vm.chainId(31339);
        string memory path = "deployments/31339.json";
        if (vm.exists(path)) vm.removeFile(path);

        script.resolve();
        script.record();

        string memory raw = vm.readFile(path);
        assertEq(vm.parseJsonAddress(raw, ".coinbaseFactory"), script.factoryAddress(), "coinbaseFactory");
        assertEq(vm.parseJsonAddress(raw, ".identity"), address(0), "identity is present and empty");
        assertEq(vm.parseJsonAddress(raw, ".entryPoint"), address(0), "entryPoint is present and empty");
        assertEq(vm.parseJsonUint(raw, ".block"), 0, "block is present and empty");

        vm.removeFile(path);
    }

    /// @dev The v1.1 pair is `lib/smart-wallet/script/DeployFactory.s.sol`'s own EXPECTED_* constants;
    ///      the v1 pair is the row above it in that repo's README deployment table.
    function test_constantsAreTheCanonicalMainnetAddresses() public view {
        assertEq(script.CREATE2_DEPLOYER(), CREATE2_DEPLOYER, "CREATE2 deployer");
        assertEq(script.MAINNET_FACTORY(), 0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a, "v1 factory");
        assertEq(script.MAINNET_IMPLEMENTATION(), 0x000100abaad02f1cfC8Bbe32bD5a564817339E72, "v1 impl");
        assertEq(script.MAINNET_FACTORY_V1_1(), 0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842, "v1.1 factory");
        assertEq(script.MAINNET_IMPLEMENTATION_V1_1(), 0x00000110dCdEdC9581cb5eCB8467282f2926534d, "v1.1 impl");
        assertEq(script.SALT(), bytes32(0), "salt");
    }

    /// @dev Puts a working factory at a canonical address that proxies to an implementation of its
    ///      own rather than Coinbase's -- what a chain where someone got to the address first looks
    ///      like. Returns that implementation.
    function _etchImpostorFactoryAt(address factorySlot) private returns (address implementation) {
        CoinbaseSmartWallet impostorImplementation = new CoinbaseSmartWallet();
        implementation = address(impostorImplementation);

        CoinbaseSmartWalletFactory impostorFactory = new CoinbaseSmartWalletFactory(implementation);
        vm.etch(factorySlot, address(impostorFactory).code);
    }

    /// @dev Puts a real factory and implementation at one of the two canonical address pairs, which
    ///      is what a chain Coinbase has already deployed to looks like from the script's point of
    ///      view. Returns the implementation, which is what the adopted factory must report.
    function _etchCanonicalAt(address factorySlot, address implementationSlot)
        private
        returns (address implementation)
    {
        CoinbaseSmartWallet realImplementation = new CoinbaseSmartWallet();
        implementation = implementationSlot;
        vm.etch(implementation, address(realImplementation).code);

        CoinbaseSmartWalletFactory realFactory = new CoinbaseSmartWalletFactory(implementation);
        vm.etch(factorySlot, address(realFactory).code);
    }
}
