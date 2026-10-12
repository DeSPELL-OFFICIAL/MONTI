// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice 슬림 저장(설계 §12, 창업자 요구)의 두 패킹을 못박는다:
///         (1) usedAt 을 serial/8 슬롯에 8장씩 담아도 이웃 티켓의 입장 시각이 섞이지 않는다.
///         (2) tokenId 가 eventId·tier·serial 을 왕복 인코딩한다(최대 범위 포함).
///         또 nonce/held 카운트 회계가 정확하고(maxPerWallet 로 상한), 첫 슬롯 쓰기(콜드)와 같은
///         슬롯의 다음 쓰기(웜)의 가스 차이를 실측한다.
contract TicketPackingTest is MontiTest {
    uint256 internal constant EVENT_SHIFT = 96;
    uint256 internal constant TIER_SHIFT = 88;

    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal gateId;

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _bigEvent(400);
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, GATE_KX, GATE_KY);
        organizers.openGate(gateId);
        vm.stopPrank();
    }

    // --- usedAt packing --------------------------------------------------------------------------

    /// @dev 슬롯 경계를 걸치는 serial 들(1·7·8·9·255·257)에서 usedAt 이 정확히 자기 값을 돌려준다.
    function test_usedAtAcrossSlotBoundaries() public {
        _mint(257);
        uint64[6] memory serials = [uint64(1), 7, 8, 9, 255, 257];
        for (uint256 i; i < serials.length; ++i) {
            uint64 ts = T0 + 3 days + serials[i]; // 서로 다른 시각으로 값 혼선을 잡는다.
            _checkInSerial(serials[i], ts);
            assertEq(ticket.usedAt(_tid(serials[i])), uint32(ts), "usedAt must be exactly this ticket's tap time");
        }
        // 서로의 값을 덮지 않았다.
        assertEq(ticket.usedAt(_tid(8)), uint32(T0 + 3 days + 8));
        assertEq(ticket.usedAt(_tid(9)), uint32(T0 + 3 days + 9));
    }

    /// @dev 띄엄띄엄(3·8·9·300) 입장시켜도 그 사이 이웃(2·4·7·10·299)은 0(미사용)으로 남는다.
    function test_sparseSerialsLeaveGapsUntouched() public {
        _mint(300);
        uint64[4] memory used = [uint64(3), 8, 9, 300];
        for (uint256 i; i < used.length; ++i) {
            _checkInSerial(used[i], T0 + 3 days + used[i]);
        }
        assertEq(ticket.usedAt(_tid(3)), uint32(T0 + 3 days + 3));
        assertEq(ticket.usedAt(_tid(8)), uint32(T0 + 3 days + 8));
        assertEq(ticket.usedAt(_tid(9)), uint32(T0 + 3 days + 9));
        assertEq(ticket.usedAt(_tid(300)), uint32(T0 + 3 days + 300));

        // gaps and same-slot neighbours stay zero.
        assertEq(ticket.usedAt(_tid(2)), 0, "serial 2 untouched");
        assertEq(ticket.usedAt(_tid(4)), 0, "serial 4 (same slot as 3) untouched");
        assertEq(ticket.usedAt(_tid(7)), 0, "serial 7 untouched");
        assertEq(ticket.usedAt(_tid(10)), 0, "serial 10 (same slot as 8,9) untouched");
        assertEq(ticket.usedAt(_tid(299)), 0, "serial 299 untouched");
    }

    /// @dev 같은 워드의 이웃은 한 번의 쓰기로 흔들리지 않는다: serial 8 을 찍은 뒤 9 를 찍어도 8 은 그대로.
    function test_neighbourInSameSlotUnaffectedByAWrite() public {
        _mint(16); // serials 8..15 share slot 1
        _checkInSerial(8, T0 + 3 days + 8);
        assertEq(ticket.usedAt(_tid(8)), uint32(T0 + 3 days + 8));
        _checkInSerial(9, T0 + 3 days + 9);
        assertEq(ticket.usedAt(_tid(8)), uint32(T0 + 3 days + 8), "writing serial 9 must not disturb serial 8");
        assertEq(ticket.usedAt(_tid(9)), uint32(T0 + 3 days + 9));
        for (uint256 s = 10; s <= 15; ++s) {
            assertEq(ticket.usedAt(_tid(s)), 0, "the rest of the word stays zero");
        }
    }

    /// @dev checkInOf 는 슬림 저장으로 ts(== usedAt)만 채우고 gateId·nonceHash 는 0 이다.
    function test_checkInOfReturnsZeroGateAndNonce() public {
        _mint(1);
        _checkInSerial(1, T0 + 3 days + 1);
        Ticket.CheckIn memory c = ticket.checkInOf(_tid(1));
        assertEq(c.ts, uint32(T0 + 3 days + 1));
        assertEq(c.gateId, 0);
        assertEq(c.nonceHash, bytes32(0));
        assertFalse(c.manual);
        assertFalse(c.late);
    }

    // --- tokenId encoding ------------------------------------------------------------------------

    function test_eventTierSerialRoundTripForAMintedToken() public {
        _mint(9);
        uint256 tid = _tid(9);
        assertEq(ticket.eventOf(tid), eventId);
        assertEq(ticket.tierOf(tid), 0);
        assertEq(tid & ((uint256(1) << 88) - 1), 9, "serial decodes from the low 88 bits");
    }

    /// @dev eventOf/tierOf 는 tokenId 순수 디코더다 — 최대 범위 값도 왕복한다(민팅 없이 검증).
    function test_encodingRoundTripAtMaxRange() public view {
        uint256 maxEvent = (uint256(1) << 160) - 1;
        uint256 maxSerial = (uint256(1) << 88) - 1;
        uint8 maxTier = 255;
        uint256 tid = (maxEvent << EVENT_SHIFT) | (uint256(maxTier) << TIER_SHIFT) | maxSerial;
        assertEq(ticket.eventOf(tid), maxEvent, "eventId occupies the high 160 bits");
        assertEq(ticket.tierOf(tid), maxTier, "tier occupies bits 88..96");
        assertEq(tid & maxSerial, maxSerial, "serial occupies the low 88 bits");
    }

    // --- nonce / held accounting (bounded, cannot overflow) -------------------------------------

    /// @dev nonce 는 발급마다 +1, held 는 보유 수와 같다 — 둘 다 maxPerWallet/supply 로 상한이므로
    ///      uint64/uint32 슬롯을 넘길 수 없다. 회계가 정확함을 여러 발급으로 못박는다.
    function test_nonceAndHeldAccountingIsExactAndBounded() public {
        _mint(5);
        assertEq(ticket.claimNonce(eventId, ALICE), 5, "nonce == number of claims");
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 5, "held == balance for this event");
    }

    /// @dev held 는 maxPerWallet 를 넘길 수 없다 — 초과분은 발급 단계에서 막힌다(오버플로 가드의 실제 상한).
    function test_maxPerWalletGuardsHeldCount() public {
        // maxPerWallet 3, supply 100 (from _freeEvent): the cap, not the supply, is what stops held.
        uint256 capped = _freeEvent(orgId, 3, 0, false);
        for (uint256 i; i < 3; ++i) {
            _claimForFixture(ALICE, capped, 0);
        }
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, capped, 0);
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.claimFor(a, sig);
    }

    // --- 8-pack SSTORE gas ----------------------------------------------------------------------

    /// @dev 한 슬롯의 첫 usedAt 쓰기는 0->비0 콜드 SSTORE 이고, 같은 슬롯의 다음 쓰기는 비0->비0 이라
    ///      훨씬 싸다 — 8장 패킹의 이득이 바로 이 차이다(설계 §12-2).
    function test_firstWriteInSlotCostsMoreThanALaterWriteInTheSameSlot() public {
        _mint(2); // serials 1,2 share slot 0

        uint256 coldUsed = _measureCheckInSerial(1, T0 + 3 days + 1);
        uint256 warmUsed = _measureCheckInSerial(2, T0 + 3 days + 2);

        emit log_named_uint("checkIn gas, first ticket in a fresh usedAt slot (cold)", coldUsed);
        emit log_named_uint("checkIn gas, later ticket in the same slot (warm word)", warmUsed);
        emit log_named_uint("slot-packing saving (gas)", coldUsed - warmUsed);
        assertGt(coldUsed, warmUsed, "the first write pays the 0->nonzero SSTORE; the rest share the word");
    }

    // --- helpers -------------------------------------------------------------------------------

    function _tid(uint256 serial) internal view returns (uint256) {
        return (eventId << EVENT_SHIFT) | serial; // tier 0
    }

    function _mint(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            _claimForFixture(ALICE, eventId, 0);
        }
    }

    function _gateCode(uint256 serial, uint64 ts) internal view returns (Ticket.GateCode memory) {
        return Ticket.GateCode({gateId: gateId, eventId: eventId, issuedAt: ts, nonce: keccak256(abi.encode(serial))});
    }

    function _checkInSerial(uint256 serial, uint64 ts) internal {
        vm.warp(ts);
        Ticket.GateCode memory g = _gateCode(serial, ts);
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(_tid(serial), g);
        vm.prank(RELAYER);
        ticket.checkInFor(_tid(serial), g, gs, ds);
    }

    function _measureCheckInSerial(uint256 serial, uint64 ts) internal returns (uint256 used) {
        vm.warp(ts);
        Ticket.GateCode memory g = _gateCode(serial, ts);
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(_tid(serial), g);
        Ticket t = ticket;
        uint256 id = _tid(serial);
        vm.prank(RELAYER);
        uint256 before = gasleft();
        t.checkInFor(id, g, gs, ds);
        used = before - gasleft();
        assertTrue(ticket.usedAt(id) != 0, "measured a real check-in");
    }

    function _bigEvent(uint32 supply) internal returns (uint256 id) {
        Ticket.EventMeta memory m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Packing"),
            descHash: keccak256("a big event to exercise usedAt packing"),
            imageCid: "bafyTestCid",
            startsAt: T0 + 2 days,
            endsAt: T0 + 100 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: false,
            transferCutoffSeconds: 0,
            maxTransfers: 0,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General", priceUsdCents: 0, supply: supply, minted: 0, maxPerWallet: uint16(supply), seated: false
        });
        vm.prank(ORG_OWNER);
        id = ticket.publishEvent(m, t, _emptyPolicy());
    }
}
