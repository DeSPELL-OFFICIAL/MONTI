// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";
import {Base64} from "solady/utils/Base64.sol";
import {JSONParserLib} from "solady/utils/JSONParserLib.sol";
import {LibString} from "solady/utils/LibString.sol";

contract TicketURITest is MontiTest {
    using JSONParserLib for JSONParserLib.Item;

    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    string internal constant NOT_ENTERED = unicode"입장 전";
    string internal constant ENTERED = unicode"입장 완료";
    string internal constant CANCELLED = unicode"취소됨";

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        tokenId = _claimForFixture(ALICE, eventId, 0);
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, GATE_KX, GATE_KY);
        organizers.openGate(gateId);
        vm.stopPrank();
    }

    function _json(uint256 id) internal view returns (string memory) {
        string memory uri = ticket.tokenURI(id);
        assertTrue(LibString.startsWith(uri, "data:application/json;base64,"), "must be an on-chain data URI");
        return string(Base64.decode(LibString.slice(uri, 29)));
    }

    /// @dev Reads one attribute back out of the decoded JSON, so a test asserts a field and not a substring.
    function _attr(string memory json, string memory traitType) internal pure returns (string memory) {
        JSONParserLib.Item memory attrs = JSONParserLib.parse(json).at('"attributes"');
        for (uint256 i; i < attrs.size(); ++i) {
            JSONParserLib.Item memory a = attrs.at(i);
            if (
                keccak256(bytes(JSONParserLib.decodeString(a.at('"trait_type"').value())))
                    == keccak256(bytes(traitType))
            ) {
                return JSONParserLib.decodeString(a.at('"value"').value());
            }
        }
        revert("attribute not found");
    }

    function _statusOf(uint256 id) internal view returns (string memory) {
        return _attr(_json(id), unicode"상태");
    }

    function _tap() internal {
        vm.warp(P256Vectors.ISSUED_AT + 5);
        Ticket.GateCode memory code = Ticket.GateCode({
            gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
        });
        // 릴레이 입장: 게이트 서명 + 관객 기기 서명을 임의 RELAYER 가 대신 제출한다.
        _checkInFor(tokenId, code);
    }

    /// @dev One published event whose organizer-supplied strings are ours to choose.
    function _eventWithText(string memory tierName, string memory cid) internal returns (uint256 id) {
        Ticket.EventMeta memory m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Night"),
            descHash: keccak256("a test event"),
            imageCid: cid,
            startsAt: T0 + 1 days,
            endsAt: T0 + 2 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: true,
            transferCutoffSeconds: 2 hours,
            maxTransfers: 1,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: tierName, priceUsdCents: 0, supply: 10, minted: 0, maxPerWallet: 1, seated: true});
        vm.prank(ORG_OWNER);
        id = ticket.publishEvent(m, t, _emptyPolicy());
    }

    function test_uriCarriesNameImageAndNotYetEnteredStatus() public view {
        string memory json = _json(tokenId);
        assertTrue(LibString.contains(json, string.concat("MONTI Ticket #", vm.toString(tokenId))));
        assertTrue(LibString.contains(json, "ipfs://bafyTestCid"));
        assertTrue(LibString.contains(json, "General"));
        assertTrue(LibString.contains(json, NOT_ENTERED));
        assertFalse(LibString.contains(json, ENTERED));
    }

    /// @dev Every byte of it comes from the chain, so every byte of it is worth pinning.
    function test_uriDecodesToTheExactJson() public view {
        assertEq(
            _json(tokenId),
            string.concat(
                '{"name":"MONTI Ticket #',
                vm.toString(tokenId),
                '",',
                '"description":"MONTI on-chain admission. The chain decides, not our server.",',
                '"image":"ipfs://bafyTestCid",',
                '"attributes":[',
                '{"trait_type":"Event","value":"1001"},',
                '{"trait_type":"Tier","value":"General"},',
                '{"trait_type":"Starts","display_type":"date","value":1800086400},',
                '{"trait_type":"Seated","value":"false"},',
                '{"trait_type":"Transferable","value":"true"},',
                unicode'{"trait_type":"상태","value":"입장 전"}]}'
            )
        );
    }

    function test_uriFlipsToEnteredAfterCheckIn() public {
        _tap();

        string memory json = _json(tokenId);
        assertTrue(LibString.contains(json, ENTERED));
        assertEq(_attr(json, unicode"상태"), ENTERED);
    }

    /// @dev A manual override writes the same CheckIn record, so the ticket reads the same way.
    function test_uriFlipsToEnteredAfterManualOverride() public {
        vm.prank(ORG_OWNER);
        ticket.manualOverride(tokenId, gateId, 3);
        assertEq(_statusOf(tokenId), ENTERED);
    }

    function test_uriShowsCancelledAfterRevoke() public {
        assertEq(_statusOf(tokenId), NOT_ENTERED);
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 1);
        assertEq(_statusOf(tokenId), CANCELLED);
    }

    /// @dev Voiding a spent ticket is allowed (Task 23), and void is the terminal state the holder sees.
    function test_revokeOutranksAnEnteredTicket() public {
        _tap();
        assertEq(_statusOf(tokenId), ENTERED);
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);
        assertEq(_statusOf(tokenId), CANCELLED);
    }

    function test_isRevokedTracksTheVoidFlag() public {
        assertFalse(ticket.isRevoked(tokenId));
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 1);
        assertTrue(ticket.isRevoked(tokenId));
    }

    /// @dev 5.8 "행사 취소 시 티켓 일괄 취소". 일괄 revoke 트랜잭션 없이, 행사 상태에서 파생한다.
    function test_uriShowsCancelledAfterTheEventIsCancelled() public {
        assertEq(_statusOf(tokenId), NOT_ENTERED);
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        assertEq(_statusOf(tokenId), CANCELLED);
    }

    /// @dev 행사 단위 무효가 티켓 단위 상태를 덮는다. 이미 들어간 티켓도 취소됨으로 읽힌다.
    function test_cancelledEventOutranksAnEnteredTicket() public {
        _tap();
        assertEq(_statusOf(tokenId), ENTERED);
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        assertEq(_statusOf(tokenId), CANCELLED);
    }

    /// @dev 끝난 행사는 취소가 아니다. Ended 는 시간이 만든 상태이고, 취소는 주최자가 만든 상태다.
    function test_endedEventDoesNotReadAsCancelled() public {
        vm.warp(T0 + 3 days);
        assertEq(_statusOf(tokenId), NOT_ENTERED);
    }

    /// @dev Tier names and image CIDs are typed by organizers. A bare quote would end the JSON string
    ///      early and let them write their own attributes, so both go through the escaper.
    function test_uriEscapesOrganizerSuppliedText() public {
        uint256 id = _eventWithText(unicode'V"I\\P\t석', 'bafy"cid');
        uint256 vip = _claimForFixture(ALICE, id, 0);

        string memory json = _json(vip);
        assertTrue(LibString.contains(json, '\\"'), "the quote must be escaped, not raw");
        assertEq(_attr(json, "Tier"), unicode'V"I\\P\t석');
        assertEq(JSONParserLib.parse(json).at('"image"').value(), '"ipfs://bafy\\"cid"');
        assertEq(_attr(json, unicode"상태"), NOT_ENTERED);
    }

    function testFuzz_uriHoldsForAnyOrganizerText(string memory tierName, string memory cid) public {
        if (bytes(tierName).length > 64) tierName = LibString.slice(tierName, 0, 64);
        if (bytes(cid).length > 64) cid = LibString.slice(cid, 0, 64);

        uint256 id = _eventWithText(tierName, cid);
        uint256 fuzzed = _claimForFixture(ALICE, id, 0);

        string memory json = _json(fuzzed);
        assertEq(_attr(json, "Tier"), tierName);
        assertEq(_attr(json, unicode"상태"), NOT_ENTERED);
    }

    function test_uriForUnknownTokenReverts() public {
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.tokenURI(999);
    }
}
