// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice 릴레이된 발급의 실행 가스를 실측한다(설계 §11-2, 스폰서/릴레이 한도 산정 근거). 서명은
///         측정 창 밖(setUp/본문 앞)에서 만든다 — 측정 안에서 만들면 sha256 프리컴파일이 미리
///         따뜻해져 콜드 비용이 사라진다. 게이트 P-256 검증이 없으므로 발급은 입장보다 싸다.
contract ClaimGasTest is MontiTest {
    uint256 internal orgId;
    uint256 internal openEventId;
    uint256 internal approvalEventId;

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        openEventId = _freeEvent(orgId, 5, 1, true);
        approvalEventId = _approvalEvent();
    }

    function test_claimForGas() public {
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, openEventId, 0);
        Ticket t = ticket;

        vm.prank(RELAYER);
        uint256 before = gasleft();
        uint256 tokenId = t.claimFor(a, sig);
        uint256 used = before - gasleft();

        assertEq(ticket.ownerOf(tokenId), ALICE, "the measured call must be a real claim");
        emit log_named_uint("claimFor gas (local osaka)", used);
    }

    function test_requestClaimForGas() public {
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, approvalEventId, 0);
        Ticket t = ticket;

        vm.prank(RELAYER);
        uint256 before = gasleft();
        uint256 rid = t.requestClaimFor(a, sig);
        uint256 used = before - gasleft();

        assertEq(rid, 1, "the measured call must be a real request");
        emit log_named_uint("requestClaimFor gas (local osaka)", used);
    }

    function _approvalEvent() internal returns (uint256 apId) {
        Ticket.EventMeta memory m = ticket.eventMeta(openEventId);
        m.approvalRequired = true;
        Ticket.Tier[] memory t = ticket.tiers(openEventId);
        vm.prank(ORG_OWNER);
        apId = ticket.publishEvent(m, t, _emptyPolicy());
    }
}
