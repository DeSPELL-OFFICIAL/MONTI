// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

abstract contract MontiTest is Test {
    Identity internal identity;
    Organizers internal organizers;
    Ticket internal ticket;
    MontiForwarder internal fwd;

    uint256 internal constant ATTESTER_PK = 0xA11CE;
    address internal attester;

    address internal constant ORG_OWNER = address(0x0140);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA);
    address internal constant GATE_A = address(0x6A7E);
    address internal constant GATE_B = address(0x6A7F);
    /// @dev 게이트도 관객도 아닌 임의의 릴레이 제출자 EOA. claimFor/checkInFor 가 permissionless
    ///      임을(msg.sender 를 인가에 쓰지 않음을) 증명하려고 입장을 이 계정으로 제출한다.
    address internal constant RELAYER = address(0x9E1A);

    /// @dev 릴레이 전환 후 게이트 권한은 msg.sender 가 아니라 게이트 키(kx,ky)의 서명이 증명한다.
    ///      게이트 코드 다이제스트를 이 키로 서명하려면 게이트를 진짜 P-256 키로 등록해야 하므로,
    ///      P256Vectors 의 두 번째(OTHER) 벡터를 게이트 키로 쓴다. 관객 기기 키(DEVICE)와 분리된다.
    uint256 internal constant GATE_PRIV = P256Vectors.OTHER_PRIV;
    bytes32 internal constant GATE_KX = P256Vectors.OTHER_X;
    bytes32 internal constant GATE_KY = P256Vectors.OTHER_Y;

    bytes32 internal constant DEV_X = bytes32(uint256(0x1111));
    bytes32 internal constant DEV_Y = bytes32(uint256(0x2222));
    uint64 internal constant T0 = 1_800_000_000;

    function _deployMonti() internal {
        attester = vm.addr(ATTESTER_PK);
        identity = new Identity(attester);
        // Deploy order (design §2): Identity -> Forwarder -> Organizers -> Ticket ->
        // setForwarder -> setTargets -> setTicket. Deployer = this test contract.
        fwd = new MontiForwarder(IIdentity(address(identity)), address(this));
        organizers = new Organizers(address(fwd));
        ticket = new Ticket(address(identity), address(organizers), address(fwd));
        identity.setForwarder(address(fwd));
        fwd.setTargets(address(ticket), address(organizers));
        organizers.setTicket(address(ticket));
        vm.warp(T0);
    }

    /// @dev Registers a member whose device key is the generated P-256 vector key, so check-in
    ///      tests (Task 20+) can present real signatures the live 0x100 precompile verifies.
    function _memberWithDeviceKey(address account, uint256 personSeed) internal {
        vm.prank(attester);
        identity.register(bytes32(personSeed), account, P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, 1);
    }

    /// @dev Default members are fully verified (kycLevel 1).
    function _member(address account, uint256 personSeed) internal {
        _memberWithLevel(account, personSeed, 1);
    }

    /// @dev 릴레이 발급/입장은 관객 기기 P-256 서명을 검증하므로, 모든 멤버를 진짜 기기 키
    ///      (P256Vectors.DEVICE)로 등록한다. Identity 는 기기 키의 계정 간 중복을 막지 않으므로
    ///      여러 멤버가 같은 벡터 키로 각자 자기 승인서/탭에 서명할 수 있다.
    function _memberWithLevel(address account, uint256 personSeed, uint8 level) internal {
        vm.prank(attester);
        identity.register(bytes32(personSeed), account, P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, level);
    }

    // --- device signatures ---------------------------------------------------------------------

    /// @dev Ticket._deviceDigest 와 **바이트가 같아야 한다**. 그 등식이 깨지면 문이 통째로 닫히
    ///      므로, 여기 한 곳에 두고 TicketCheckIn.t.sol 이 컨트랙트 쪽과 맞는지 못박는다.
    function _deviceDigest(uint256 tokenId_, Ticket.GateCode memory g) internal view returns (bytes32) {
        return sha256(abi.encode(block.chainid, address(ticket), tokenId_, g.gateId, g.eventId, g.nonce, g.issuedAt));
    }

    /// @dev 다이제스트가 이 체인과 이 배포본에 묶여 있으므로(Gap 2) 서명을 상수로 들고 있을 수
    ///      없다 -- 테스트 배포마다 Ticket 주소가 다르다. vm.signP256 은 RFC 6979 결정적 서명에
    ///      low-s 까지 정규화해 주고, P256Vectors.t.sol 이 그것을 noble 벡터와 맞춰 둔다.
    function _deviceRS(uint256 privKey, uint256 tokenId_, Ticket.GateCode memory g)
        internal
        view
        returns (bytes32 r, bytes32 s)
    {
        return vm.signP256(privKey, _deviceDigest(tokenId_, g));
    }

    /// @dev 관객의 진짜 기기 키로 그 탭에 서명한다.
    function _deviceSig(uint256 tokenId_, Ticket.GateCode memory g) internal view returns (bytes memory) {
        (bytes32 r, bytes32 s) = _deviceRS(P256Vectors.DEVICE_PRIV, tokenId_, g);
        return abi.encode(r, s);
    }

    /// @dev 통과해서는 안 되는 키로 같은 탭에 서명한다.
    function _foreignDeviceSig(uint256 tokenId_, Ticket.GateCode memory g) internal view returns (bytes memory) {
        (bytes32 r, bytes32 s) = _deviceRS(P256Vectors.OTHER_PRIV, tokenId_, g);
        return abi.encode(r, s);
    }

    // --- gate signatures (릴레이 입장) -----------------------------------------------------------

    /// @dev Ticket._verifyGate 와 **바이트가 같아야 한다**. 스태프 앱이 이미 서명하는 게이트 코드
    ///      다이제스트(gateCodeHash)를 온체인에서도 검증할 뿐이다(설계 §4).
    function _gateCodeDigest(Ticket.GateCode memory g) internal pure returns (bytes32) {
        return sha256(abi.encode(g.gateId, g.eventId, g.issuedAt, g.nonce));
    }

    /// @dev 게이트 키(GATE_PRIV)로 게이트 코드에 서명한다. checkInFor 의 gateSig 인자로 넘긴다.
    function _gateSig(Ticket.GateCode memory g) internal view returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(GATE_PRIV, _gateCodeDigest(g));
        return abi.encode(r, s);
    }

    /// @dev 통과해서는 안 되는 키(관객 기기 키)로 게이트 코드에 서명한다 — 위조 게이트 서명.
    function _foreignGateSig(Ticket.GateCode memory g) internal view returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, _gateCodeDigest(g));
        return abi.encode(r, s);
    }

    /// @dev 진짜 게이트 키로 게이트를 등록하고 연다. 릴레이 입장 테스트가 이 gateId 로 서명한다.
    function _openRealGate(uint256 eventId, address gateAccount) internal returns (uint256 gateId) {
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, gateAccount, GATE_KX, GATE_KY);
        organizers.openGate(gateId);
        vm.stopPrank();
    }

    // --- relayed claim (claimFor) ----------------------------------------------------------------

    /// @dev 관객 기기 키로 ClaimAuth 에 서명하고 claimFor 로 발급한다(permissionless, prank 불필요).
    ///      nonce 는 체인의 현재 (eventId, account) nonce 를 읽어 채운다. account 는 진짜 DEVICE
    ///      키로 등록돼 있어야 한다(_member/_memberWithDeviceKey).
    function _claimForFixture(address account, uint256 eventId, uint8 tier) internal returns (uint256 tokenId) {
        Ticket.ClaimAuth memory a = Ticket.ClaimAuth({
            eventId: eventId,
            tier: tier,
            account: account,
            nonce: ticket.claimNonce(eventId, account),
            deadline: uint64(block.timestamp + 10 minutes)
        });
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, ticket.claimAuthDigest(a));
        tokenId = ticket.claimFor(a, abi.encode(r, s));
    }

    /// @dev 티어 0 편의 오버로드.
    function _claimForFixture(address account, uint256 eventId) internal returns (uint256 tokenId) {
        return _claimForFixture(account, eventId, 0);
    }

    /// @dev claimFor/requestClaimFor 의 (승인서, 기기서명) 쌍만 만든다 — 호출은 하지 않는다.
    ///      expectRevert/expectEmit 직전에 불러 두면, 승인서 nonce 를 읽는 뷰 콜과 vm.signP256 이
    ///      그 치트코드 창을 먹어 치우지 않는다(발급을 실제로 쏘는 것은 테스트 본문이다).
    function _signClaimAuth(address account, uint256 eventId, uint8 tier)
        internal
        view
        returns (Ticket.ClaimAuth memory a, bytes memory sig)
    {
        a = Ticket.ClaimAuth({
            eventId: eventId,
            tier: tier,
            account: account,
            nonce: ticket.claimNonce(eventId, account),
            deadline: uint64(block.timestamp + 10 minutes)
        });
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, ticket.claimAuthDigest(a));
        sig = abi.encode(r, s);
    }

    /// @dev 회전으로 새 계정이 된 뒤 그 계정에 관객 기기 키(DEVICE 벡터)를 심는다. rotateAccount 는
    ///      새 계정의 기기 키를 세우지 않으므로(Identity), 릴레이 발급이 검증하는 관객 기기 서명이
    ///      새 계정에서 통과하려면 정상 경로(setActiveDevice, 새 패스키 등록에 해당)로 한 번 심어야
    ///      한다. 회전 격리(_update)의 발급 경로를 그대로 검증하기 위한 것이다.
    function _giveDeviceKey(address account) internal {
        vm.prank(account);
        identity.setActiveDevice(P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y);
    }

    /// @dev 승인제 신청을 실제로 쏜다(permissionless). 성공 경로 픽스처용. requestId 를 돌려준다.
    function _requestClaimForFixture(address account, uint256 eventId, uint8 tier)
        internal
        returns (uint256 requestId)
    {
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(account, eventId, tier);
        requestId = ticket.requestClaimFor(a, sig);
    }

    // --- relayed check-in (checkInFor / checkInForLate) ------------------------------------------

    /// @dev 릴레이 입장(현장). 게이트 서명 + 관객 기기 서명을 먼저 만든 뒤, 게이트도 관객도 아닌
    ///      임의 RELAYER EOA 가 제출한다(permissionless). 게이트는 _openRealGate 로 진짜 P-256
    ///      키(GATE_KX/GATE_KY)로 등록돼 있어야 _gateSig 가 통과한다.
    function _checkInFor(uint256 tokenId_, Ticket.GateCode memory g) internal {
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(tokenId_, g);
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId_, g, gs, ds);
    }

    /// @dev 릴레이 입장(오프라인 큐 플러시).
    function _checkInForLate(uint256 tokenId_, Ticket.GateCode memory g) internal {
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(tokenId_, g);
        vm.prank(RELAYER);
        ticket.checkInForLate(tokenId_, g, gs, ds);
    }

    function _org() internal returns (uint256 orgId) {
        orgId = organizers.createOrganizer(ORG_OWNER);
    }

    /// @dev One published event, one free tier, sale open now, doors in 1 day, 2-hour transfer cutoff.
    function _freeEvent(uint256 orgId, uint16 maxPerWallet, uint8 maxTransfers, bool transferable)
        internal
        returns (uint256 eventId)
    {
        return _event(orgId, maxPerWallet, maxTransfers, transferable, false);
    }

    /// @dev Same shape, but the organizer demands ID + face verification (kycLevel >= 1).
    function _kycEvent(uint256 orgId) internal returns (uint256 eventId) {
        return _event(orgId, 2, 1, true, true);
    }

    function _event(uint256 orgId, uint16 maxPerWallet, uint8 maxTransfers, bool transferable, bool requireKyc)
        internal
        returns (uint256 eventId)
    {
        Ticket.EventMeta memory m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Night"),
            descHash: keccak256("a test event"),
            imageCid: "bafyTestCid",
            startsAt: T0 + 1 days,
            endsAt: T0 + 2 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: transferable,
            transferCutoffSeconds: 2 hours,
            maxTransfers: maxTransfers,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: requireKyc
        });
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General", priceUsdCents: 0, supply: 100, minted: 0, maxPerWallet: maxPerWallet, seated: false
        });
        vm.prank(ORG_OWNER);
        eventId = ticket.createEvent(m, t);
        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId);
    }

    // --- relayed forward (MontiForwarder.execute) ------------------------------------------------

    function _fwdReq(address from, address to, bytes memory data)
        internal
        view
        returns (MontiForwarder.ForwardRequest memory r)
    {
        r = MontiForwarder.ForwardRequest({
            from: from, to: to, nonce: fwd.nonces(from), deadline: uint64(block.timestamp + 10 minutes), data: data
        });
    }

    /// @dev Signs forwardDigest with the attendee device key (DEVICE vector).
    function _fwdSign(MontiForwarder.ForwardRequest memory r) internal view returns (bytes memory) {
        (bytes32 sr, bytes32 ss) = vm.signP256(P256Vectors.DEVICE_PRIV, fwd.forwardDigest(r));
        return abi.encode(sr, ss);
    }

    /// @dev RELAYER EOA relays a signed request to the target (permissionless).
    function _execFwd(address from, address to, bytes memory data) internal returns (bytes memory) {
        MontiForwarder.ForwardRequest memory r = _fwdReq(from, to, data);
        bytes memory sig = _fwdSign(r);
        vm.prank(RELAYER);
        return fwd.execute(r, sig);
    }
}
