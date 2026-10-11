// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The slice of Ticket its callers bind to. On chain that is one reader: Organizers resolves
///         an event to its organizer with `eventOrg`. `eventOf` and `isRevoked` have no on-chain caller
///         — they ride along so the mocks and sub-plan 04's readers share one typed view of a ticket.
///         `ClaimAuth` lives here (v2 design §3) so Ticket, SettlementVault and the tests share one
///         declaration of the relayed-claim authorisation.
interface ITicket {
    /// @notice 릴레이된 발급의 승인서. 관객 기기 키(P-256)가 `claimAuthDigest` 에 서명한다.
    ///         `account` 는 티켓을 받을 스마트 계정(수신자)이고, `nonce` 는 (eventId, account) 별
    ///         claim nonce(== claimNonce(eventId, account))다. `deadline` 은 미제출 승인서의 수명을
    ///         제한한다(block.timestamp <= deadline). 무료 발급(`claimFor`)과 유료 구매
    ///         (`SettlementVault.purchase` → `mintPaid`)가 같은 승인서를 쓴다.
    struct ClaimAuth {
        uint256 eventId;
        uint8 tier;
        address account;
        uint256 nonce;
        uint64 deadline;
    }

    function eventOrg(uint256 eventId) external view returns (uint256);
    function eventOf(uint256 tokenId) external view returns (uint256);
    function isRevoked(uint256 tokenId) external view returns (bool);
}
