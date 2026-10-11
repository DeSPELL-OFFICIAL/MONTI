// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {Organizers} from "../src/Organizers.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {P256} from "solady/utils/P256.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice 릴레이(포워더) 경유 스폰서드 동작의 실행 가스를 실측한다(설계 §11, 릴레이어 한도 산정 근거).
///         각 동작을 `MontiForwarder.execute` 로 한 번, 그리고 직접 호출(같은 계정이 대상 컨트랙트를
///         바로 부르는 경로 — ERC2771Context 는 트러스티드 포워더가 아닌 호출자에겐 raw msg.sender 를
///         돌려주므로 그대로 동작한다)로 한 번 재서, 포워더가 얹는 순수 오버헤드를 드러낸다.
///
///         측정 위생(ClaimGas/CheckInGas 와 동일): 서명(vm.signP256)은 `gasleft()` 창 밖에서 만든다 —
///         창 안에서 만들면 sha256/P-256 프리컴파일이 미리 따뜻해져 콜드 비용이 사라지고 prank 도
///         먹힌다. 포워더 경로와 직접 경로는 각각 **자기 테스트 함수**에서 setUp 직후의 신선한 상태로
///         재므로(포지리는 테스트마다 setUp 을 다시 돈다) 콜드/웜 조건이 서로 같다.
///
///         ── P-256 정규화(핵심) ─────────────────────────────────────────────────────────────
///         로컬 EVM 은 `evm_version = "osaka"` 라서 0x100 에 **진짜** P-256 프리컴파일(EIP-7951
///         P256VERIFY)이 있고, 검증 1회에 6,900 가스가 든다(솔라디 래퍼 포함 실측 ~7.2k). 폴백
///         솔리디티 검증기(~100–330k)로 떨어지지 **않는다** — extcodesize(0x100)=0 이어도 프리컴파일은
///         살아 있다(test_p256Baseline 이 이를 못박는다). 따라서 A4 는 태스크의 "폴백을 빼라"가 아니라
///         **진짜 프리컴파일로 재고 체인 차이만 뺀다**: Monad 는 RIP-7212 를 검증 1회 3,450 가스로
///         제공하므로, execute 가 정확히 검증 1회를 하는 이 경로의 Monad 등가치는
///         `local − (6,900 − 3,450) = local − 3,450` 이다. 솔라디 래퍼(~300)는 두 체인에서 같으므로
///         빼지 않는다. 직접 경로는 P-256 검증이 없으므로 정규화가 없다(acceptOffer 의 어테스터
///         ecrecover 는 secp256k1 0x01 프리컴파일이라 두 체인에서 3,000 으로 동일 — 정규화 대상 아님).
contract ForwardGasTest is MontiTest {
    /// @dev 로컬 osaka 프리컴파일 vs Monad RIP-7212. execute 는 정확히 검증 1회.
    uint256 internal constant LOCAL_P256_VERIFY = 6_900;
    uint256 internal constant MONAD_P256_VERIFY = 3_450;
    uint256 internal constant P256_DELTA = LOCAL_P256_VERIFY - MONAD_P256_VERIFY; // 3,450

    uint256 internal orgId;
    uint256 internal freeEventId;
    uint256 internal approvalEventId;
    uint256 internal closedGateId;
    uint256 internal tokenForOffer;
    uint256 internal tokenForAccept;

    bytes32 internal constant OFFER_COMMIT = keccak256("bob-handle");
    bytes internal acceptSig; // 어테스터가 offerDigest(tokenForAccept, commit, BOB) 에 서명한 것

    function setUp() public {
        _deployMonti();
        // 포워더 from 은 Identity 멤버 + 활성 기기 키(DEVICE 벡터)여야 서명이 통과한다. 주최자 owner 도
        // 릴레이로 자기 라이프사이클을 돌리므로 멤버로 등록한다(설계 §2, seed 와 같은 패턴).
        _member(ORG_OWNER, 0x0140);
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);

        orgId = organizers.createOrganizer(ORG_OWNER);
        freeEventId = _event(orgId, 10, 2, true, false); // published, transferable — 오퍼용

        approvalEventId = _approvalEvent(); // approveClaims/cancelRequest 측정용
        for (uint256 i; i < 10; ++i) {
            _requestClaimForFixture(ALICE, approvalEventId, 0); // rid 1..10, 모두 대기
        }

        // openGate 측정용: v2 는 등록이 곧 개장이므로 한 번 닫아 둔다.
        vm.startPrank(ORG_OWNER);
        closedGateId = organizers.registerGate(freeEventId, GATE_A, GATE_KX, GATE_KY);
        organizers.closeGate(closedGateId);
        vm.stopPrank();

        tokenForOffer = _claimForFixture(ALICE, freeEventId); // createOffer 측정용
        tokenForAccept = _claimForFixture(ALICE, freeEventId); // acceptOffer 측정용
        vm.prank(ALICE);
        ticket.createOffer(tokenForAccept, OFFER_COMMIT, uint64(T0 + 12 hours));
        bytes32 d = ticket.offerDigest(tokenForAccept, OFFER_COMMIT, BOB);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, d);
        acceptSig = abi.encodePacked(r, s, v);
    }

    // --- 측정 헬퍼 --------------------------------------------------------------------------------

    /// @dev 서명은 창 밖에서. 창 안엔 execute 하나만. 반환은 실행 가스.
    function _fwdGas(address from, address to, bytes memory data) internal returns (uint256 used) {
        MontiForwarder.ForwardRequest memory req = _fwdReq(from, to, data);
        bytes memory sig = _fwdSign(req);
        vm.prank(RELAYER);
        uint256 g = gasleft();
        fwd.execute(req, sig);
        used = g - gasleft();
    }

    /// @dev 같은 calldata 를 대상이 직접 받는다(호출자 = actor, 포워더 아님 → _msgSender()=actor).
    function _directGas(address actor, address to, bytes memory data) internal returns (uint256 used) {
        vm.prank(actor);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = to.call(data);
        used = g - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _logFwd(string memory name, uint256 used) internal {
        emit log_named_uint(string.concat(name, " | fwd local"), used);
        emit log_named_uint(string.concat(name, " | fwd monad-eq (-3450)"), used - P256_DELTA);
    }

    function _logDirect(string memory name, uint256 used) internal {
        emit log_named_uint(string.concat(name, " | direct local"), used);
    }

    // --- fixtures ---------------------------------------------------------------------------------

    function _meta(uint16 mpw, bool transferable, bool approval)
        internal
        view
        returns (Ticket.EventMeta memory m, Ticket.Tier[] memory t)
    {
        m = Ticket.EventMeta({
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
            maxTransfers: 2,
            approvalRequired: approval,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
        t = new Ticket.Tier[](1);
        t[0] =
            Ticket.Tier({name: "General", priceUsdCents: 0, supply: 100, minted: 0, maxPerWallet: mpw, seated: false});
    }

    function _approvalEvent() internal returns (uint256 eventId) {
        (Ticket.EventMeta memory m, Ticket.Tier[] memory t) = _meta(20, false, true);
        vm.prank(ORG_OWNER);
        eventId = ticket.publishEvent(m, t, _emptyPolicy());
    }

    function _paidPublishData() internal view returns (bytes memory) {
        (Ticket.EventMeta memory m, Ticket.Tier[] memory t) = _meta(10, true, false);
        t[0].priceUsdCents = 1000;
        return abi.encodeCall(Ticket.publishEvent, (m, t, _goodPolicy()));
    }

    function _freePublishData() internal view returns (bytes memory) {
        (Ticket.EventMeta memory m, Ticket.Tier[] memory t) = _meta(10, true, false);
        return abi.encodeCall(Ticket.publishEvent, (m, t, _emptyPolicy()));
    }

    function _ids(uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = i + 1; // rid 1..n
        }
    }

    // --- P-256 정규화 기준 --------------------------------------------------------------------------

    /// @notice 정규화의 근거를 한 자리에 못박는다: 0x100 은 진짜 프리컴파일이고(폴백 아님) 검증은 ~6.9k.
    function test_p256Baseline() public {
        bytes32 digest = sha256("monti-forward-baseline");
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, digest);
        uint256 sz;
        address p = address(0x100);
        assembly {
            sz := extcodesize(p)
        }
        assertEq(sz, 0, "precompiles report extcodesize 0 (they are not accounts with code)");

        uint256 g = gasleft();
        bool ok = P256.verifySignature(digest, r, s, P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y);
        uint256 used = g - gasleft();

        assertTrue(ok, "the osaka 0x100 precompile must verify a valid signature (no Solidity fallback)");
        assertLt(used, 10_000, "a live precompile verify is ~7k; a Solidity fallback would be >100k");
        emit log_named_uint("P256.verifySignature gas (local osaka, wrapper incl.)", used);
        emit log_named_uint("normalisation delta subtracted per forwarded action", P256_DELTA);
    }

    // --- createOrganizer (organizers, permissionless) --------------------------------------------

    function test_createOrganizer_fwd() public {
        bytes memory data = abi.encodeCall(Organizers.createOrganizer, (ALICE));
        _logFwd("createOrganizer", _fwdGas(ALICE, address(organizers), data));
    }

    function test_createOrganizer_direct() public {
        bytes memory data = abi.encodeCall(Organizers.createOrganizer, (ALICE));
        _logDirect("createOrganizer", _directGas(ALICE, address(organizers), data));
    }

    // --- publishEvent free (ticket, owner) -------------------------------------------------------

    function test_publishEventFree_fwd() public {
        _logFwd("publishEvent(free)", _fwdGas(ORG_OWNER, address(ticket), _freePublishData()));
    }

    function test_publishEventFree_direct() public {
        _logDirect("publishEvent(free)", _directGas(ORG_OWNER, address(ticket), _freePublishData()));
    }

    // --- publishEvent paid: create + frozen policy + publish (ticket → vault, owner) -------------

    function test_publishEventPaid_fwd() public {
        _logFwd("publishEvent(paid, 4 recipients)", _fwdGas(ORG_OWNER, address(ticket), _paidPublishData()));
    }

    function test_publishEventPaid_direct() public {
        _logDirect("publishEvent(paid, 4 recipients)", _directGas(ORG_OWNER, address(ticket), _paidPublishData()));
    }

    // --- registerGate (organizers, owner) --------------------------------------------------------

    function test_registerGate_fwd() public {
        bytes memory data = abi.encodeCall(Organizers.registerGate, (freeEventId, GATE_B, GATE_KX, GATE_KY));
        _logFwd("registerGate", _fwdGas(ORG_OWNER, address(organizers), data));
    }

    function test_registerGate_direct() public {
        bytes memory data = abi.encodeCall(Organizers.registerGate, (freeEventId, GATE_B, GATE_KX, GATE_KY));
        _logDirect("registerGate", _directGas(ORG_OWNER, address(organizers), data));
    }

    // --- openGate (organizers, owner) ------------------------------------------------------------

    function test_openGate_fwd() public {
        bytes memory data = abi.encodeCall(Organizers.openGate, (closedGateId));
        _logFwd("openGate", _fwdGas(ORG_OWNER, address(organizers), data));
    }

    function test_openGate_direct() public {
        bytes memory data = abi.encodeCall(Organizers.openGate, (closedGateId));
        _logDirect("openGate", _directGas(ORG_OWNER, address(organizers), data));
    }

    // --- approveClaims 1 / 5 / 10 (ticket, owner) ------------------------------------------------

    function test_approveClaims1_fwd() public {
        bytes memory data = abi.encodeCall(Ticket.approveClaims, (approvalEventId, _ids(1)));
        _logFwd("approveClaims(1)", _fwdGas(ORG_OWNER, address(ticket), data));
    }

    function test_approveClaims1_direct() public {
        bytes memory data = abi.encodeCall(Ticket.approveClaims, (approvalEventId, _ids(1)));
        _logDirect("approveClaims(1)", _directGas(ORG_OWNER, address(ticket), data));
    }

    function test_approveClaims5_fwd() public {
        bytes memory data = abi.encodeCall(Ticket.approveClaims, (approvalEventId, _ids(5)));
        _logFwd("approveClaims(5)", _fwdGas(ORG_OWNER, address(ticket), data));
    }

    function test_approveClaims5_direct() public {
        bytes memory data = abi.encodeCall(Ticket.approveClaims, (approvalEventId, _ids(5)));
        _logDirect("approveClaims(5)", _directGas(ORG_OWNER, address(ticket), data));
    }

    function test_approveClaims10_fwd() public {
        bytes memory data = abi.encodeCall(Ticket.approveClaims, (approvalEventId, _ids(10)));
        _logFwd("approveClaims(10)", _fwdGas(ORG_OWNER, address(ticket), data));
    }

    function test_approveClaims10_direct() public {
        bytes memory data = abi.encodeCall(Ticket.approveClaims, (approvalEventId, _ids(10)));
        _logDirect("approveClaims(10)", _directGas(ORG_OWNER, address(ticket), data));
    }

    // --- createOffer (ticket, token owner) -------------------------------------------------------

    function test_createOffer_fwd() public {
        bytes memory data =
            abi.encodeCall(Ticket.createOffer, (tokenForOffer, keccak256("carol"), uint64(T0 + 12 hours)));
        _logFwd("createOffer", _fwdGas(ALICE, address(ticket), data));
    }

    function test_createOffer_direct() public {
        bytes memory data =
            abi.encodeCall(Ticket.createOffer, (tokenForOffer, keccak256("carol"), uint64(T0 + 12 hours)));
        _logDirect("createOffer", _directGas(ALICE, address(ticket), data));
    }

    // --- acceptOffer (ticket, recipient) ---------------------------------------------------------

    function test_acceptOffer_fwd() public {
        bytes memory data = abi.encodeCall(Ticket.acceptOffer, (tokenForAccept, acceptSig));
        _logFwd("acceptOffer", _fwdGas(BOB, address(ticket), data));
    }

    function test_acceptOffer_direct() public {
        bytes memory data = abi.encodeCall(Ticket.acceptOffer, (tokenForAccept, acceptSig));
        _logDirect("acceptOffer", _directGas(BOB, address(ticket), data));
    }

    // --- cancelRequest (ticket, requester) -------------------------------------------------------

    function test_cancelRequest_fwd() public {
        bytes memory data = abi.encodeCall(Ticket.cancelRequest, (approvalEventId, 1));
        _logFwd("cancelRequest", _fwdGas(ALICE, address(ticket), data));
    }

    function test_cancelRequest_direct() public {
        bytes memory data = abi.encodeCall(Ticket.cancelRequest, (approvalEventId, 1));
        _logDirect("cancelRequest", _directGas(ALICE, address(ticket), data));
    }
}
