// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

contract TicketOfferTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    bytes32 internal constant COMMITMENT = keccak256("phone:+821012345678");

    /// @dev I8 의 온·오프체인 합의점. 이 두 상수는 packages/shared/src/encoding.hash.test.ts 에
    ///      글자 그대로 복사돼 있고, 한쪽만 바뀌면 그쪽 테스트가 빨개진다.
    address internal constant SHARED_VECTOR_TICKET = address(0x7111111111111111111111111111111111111111);
    bytes32 internal constant SHARED_VECTOR_DIGEST = 0x7171ab3831d8e0d4a58ce6d8076a10c080c5a97849229aecf84c801dcafbc88d;

    event OfferCreated(uint256 indexed tokenId, address indexed from, bytes32 recipientCommitment, uint64 expiresAt);
    event OfferAccepted(uint256 indexed tokenId, address indexed from, address indexed to);
    event OfferCancelled(uint256 indexed tokenId);

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 2, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
    }

    function _sig(uint256 tokenId_, bytes32 commitment, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, ticket.offerDigest(tokenId_, commitment, to));
        return abi.encodePacked(r, s, v);
    }

    function test_createAndAcceptOffer() public {
        vm.expectEmit(true, true, false, true);
        emit OfferCreated(tokenId, ALICE, COMMITMENT, T0 + 1 hours);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        Ticket.Offer memory o = ticket.offerOf(tokenId);
        assertEq(o.from, ALICE);
        assertEq(o.recipientCommitment, COMMITMENT);

        bytes memory sig = _sig(tokenId, COMMITMENT, BOB);
        vm.expectEmit(true, true, true, false);
        emit OfferAccepted(tokenId, ALICE, BOB);
        vm.prank(BOB);
        ticket.acceptOffer(tokenId, sig);

        assertEq(ticket.ownerOf(tokenId), BOB);
        assertEq(ticket.transfersOf(tokenId), 1, "an accepted offer counts as one transfer");
        assertEq(ticket.offerOf(tokenId).from, address(0));
    }

    function test_acceptRejectsWrongAttesterSignature() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBADBAD), ticket.offerDigest(tokenId, COMMITMENT, BOB));
        vm.prank(BOB);
        vm.expectRevert(Ticket.BadAttesterSig.selector);
        ticket.acceptOffer(tokenId, abi.encodePacked(r, s, v));
    }

    function test_signatureIsBoundToTheAcceptingAccount() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        bytes memory sig = _sig(tokenId, COMMITMENT, BOB);
        vm.prank(CAROL);
        vm.expectRevert(Ticket.BadAttesterSig.selector);
        ticket.acceptOffer(tokenId, sig);
    }

    function test_expiredOfferRejected() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);
        vm.warp(T0 + 1 hours + 1);

        bytes memory sig = _sig(tokenId, COMMITMENT, BOB);
        vm.prank(BOB);
        vm.expectRevert(Ticket.OfferExpired.selector);
        ticket.acceptOffer(tokenId, sig);
    }

    function test_offerIsVoidAfterAPlainTransfer() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.expectEmit(true, false, false, false);
        emit OfferCancelled(tokenId);
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, CAROL, tokenId);

        assertEq(ticket.offerOf(tokenId).from, address(0));
        bytes memory sig = _sig(tokenId, COMMITMENT, BOB);
        vm.prank(BOB);
        vm.expectRevert(Ticket.NoOffer.selector);
        ticket.acceptOffer(tokenId, sig);
    }

    function test_acceptOfferBlockedForLevelZeroOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        vm.prank(ALICE);
        uint256 kycToken = ticket.claim(kycEventId, 0, "");
        _memberWithLevel(address(0xD0), 0xD0D0, 0);

        vm.prank(ALICE);
        ticket.createOffer(kycToken, COMMITMENT, T0 + 1 hours);
        bytes memory sig = _sig(kycToken, COMMITMENT, address(0xD0));
        vm.prank(address(0xD0));
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.acceptOffer(kycToken, sig);
    }

    function test_onlyOwnerCreatesOrCancels() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.cancelOffer(tokenId);

        vm.prank(ALICE);
        ticket.cancelOffer(tokenId);
        assertEq(ticket.offerOf(tokenId).from, address(0));
    }

    /// @dev The cutoff instant itself is closed for a transfer, so an offer created at that instant
    ///      could never be collected. `createOffer` closes on the same boundary `_update` does.
    function test_createOfferAtExactCutoffReverts() public {
        vm.warp(T0 + 1 days - 2 hours);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 days);
    }

    /// @dev One second earlier the handoff still completes, which is the boundary's other side.
    function test_offerCreatedOneSecondBeforeTheCutoffIsStillCollectable() public {
        vm.warp(T0 + 1 days - 2 hours - 1);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 days);

        bytes memory sig = _sig(tokenId, COMMITMENT, BOB);
        vm.prank(BOB);
        ticket.acceptOffer(tokenId, sig);
        assertEq(ticket.ownerOf(tokenId), BOB);
    }

    /// @dev Admission kills a live offer, so the recipient cannot accept a ticket that is already inside.
    function test_offerIsVoidAfterCheckIn() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, uint64(P256Vectors.ISSUED_AT + 1 hours));

        uint256 gateId;
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();

        vm.warp(P256Vectors.ISSUED_AT + 5);
        vm.prank(GATE_A);
        ticket.checkIn(
            tokenId,
            Ticket.GateCode({
                gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
            }),
            abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S)
        );

        assertEq(ticket.offerOf(tokenId).from, address(0));
        bytes memory sig = _sig(tokenId, COMMITMENT, BOB);
        vm.prank(BOB);
        vm.expectRevert(Ticket.NoOffer.selector);
        ticket.acceptOffer(tokenId, sig);
    }

    /// @dev acceptOffer 도 _update 를 타므로 I1 의 보내는 쪽 가드를 그대로 받는다. 오퍼를 낸 뒤
    ///      폰을 잃어버려 잠갔다면, 받는 쪽이 이미 서명을 들고 있어도 티켓은 움직이지 않는다.
    function test_acceptOfferRefusesALockedSeller() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.prank(ALICE);
        identity.lockDevice(ALICE);

        bytes memory sig = _sig(tokenId, COMMITMENT, BOB);
        vm.prank(BOB);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.acceptOffer(tokenId, sig);
        assertEq(ticket.ownerOf(tokenId), ALICE);
        assertEq(ticket.offerOf(tokenId).from, ALICE, "a refused accept leaves the offer standing");
    }

    /// @dev 받는 쪽 잠금도 같은 문에서 막힌다. 쓸 수 없는 계정으로 티켓을 밀어 넣으면 그 티켓은
    ///      잠금이 풀릴 때까지 아무 데도 못 가고 문도 통과하지 못한다.
    function test_acceptOfferRefusesALockedRecipient() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.prank(BOB);
        identity.lockDevice(BOB);

        bytes memory sig = _sig(tokenId, COMMITMENT, BOB);
        vm.prank(BOB);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.acceptOffer(tokenId, sig);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    /// @dev I8. 다이제스트가 chain id 와 검증 컨트랙트 주소를 묶는지, EIP-712 정의대로 계산한
    ///      값과 한 바이트도 다르지 않은지 본다. 여기 쓰인 문자열이 곧 02 의 domain/types 다.
    function test_offerDigestIsTheEip712TypedDataHash() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MONTI Ticket"),
                keccak256("1"),
                block.chainid,
                address(ticket)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("TransferApproval(uint256 tokenId,bytes32 recipientCommitment,address recipient)"),
                tokenId,
                COMMITMENT,
                BOB
            )
        );
        assertEq(
            ticket.offerDigest(tokenId, COMMITMENT, BOB), keccak256(abi.encodePacked(hex"1901", domain, structHash))
        );
    }

    /// @dev 같은 (tokenId, commitment, recipient) 에 대한 서명이 다른 Ticket 배포본에서는 안 먹힌다.
    ///      재배포할 때마다 옛 서명이 죽는다는 것이 이 줄의 뜻이다.
    function test_aSignatureDoesNotCrossToAnotherTicketDeployment() public {
        Ticket other = new Ticket(address(identity), address(organizers));
        assertTrue(
            ticket.offerDigest(tokenId, COMMITMENT, BOB) != other.offerDigest(tokenId, COMMITMENT, BOB),
            "verifyingContract must be in the domain"
        );
    }

    /// @dev 체인이 다르면 다이제스트도 다르다. 테스트넷 서명이 메인넷에서 못 쓰인다.
    function test_aSignatureDoesNotCrossChains() public {
        bytes32 here = ticket.offerDigest(tokenId, COMMITMENT, BOB);
        vm.chainId(143);
        assertTrue(here != ticket.offerDigest(tokenId, COMMITMENT, BOB), "chainId must be in the domain");
    }

    /// @dev Step 3b: packages/shared 의 고정 벡터가 맞춰야 하는 값을 여기서 못박는다. 도메인이
    ///      chainId 와 Ticket 주소를 묶으므로 둘 다 이 테스트 안에서 고정한다 — 재배포해도
    ///      이 값은 흔들리지 않고, offerDigest.test.ts 가 같은 상수를 단언한다.
    function test_theFixedVectorSharedWithTheTypescriptHalf() public {
        vm.chainId(31337);
        Ticket pinned = Ticket(SHARED_VECTOR_TICKET);
        deployCodeTo("Ticket.sol:Ticket", abi.encode(address(identity), address(organizers)), SHARED_VECTOR_TICKET);
        assertEq(
            pinned.offerDigest(
                7, bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)), address(0x1)
            ),
            SHARED_VECTOR_DIGEST,
            "packages/shared/src/encoding.hash.test.ts pins the same hex"
        );
    }
}
