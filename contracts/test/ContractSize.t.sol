// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";
import {Identity} from "../src/Identity.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";

/// @notice 한도는 EIP-170 의 24,576 B 가 아니라 Monad 의 128 KB 다(Task 1 이 foundry.toml 에
///         code_size_limit 으로 못박았다). 이 테스트는 그 한도를 테스트로 들고 있어서, 어느
///         커밋이 얼마나 썼는지 그 자리에서 드러나게 한다.
///
///         런타임과 이니트코드를 둘 다 본다. 이니트코드가 먼저 걸린다 — Ticket 의 생성 코드는
///         런타임보다 756 B 크고, 배포 트랜잭션이 통과해야 하는 것은 그쪽이다.
///
///         이 파일이 크기 게이트의 유일한 소재지다. forge 1.5.1 의 `forge build --sizes` 는
///         code_size_limit 을 무시하고 EIP-170 의 24,576 B 에서 종료 코드 1 을 내므로
///         .github-checks.sh 는 `forge build` 만 돌린다. Monad 가 실제로 받아들이는 크기를
///         아는 것은 여기뿐이다.
contract ContractSizeTest is Test {
    /// @dev foundry.toml 의 code_size_limit 과 같은 값. revm 은 EIP-3860 이니트코드 상한도
    ///      이 값에서 유도하므로 둘을 같은 상수로 잰다.
    uint256 internal constant MONAD_CODE_SIZE_LIMIT = 131_072;

    function test_ticketFitsUnderMonadsLimit() public {
        Identity identity = new Identity(address(0xA11CE));
        Organizers organizers = new Organizers(address(0));
        Ticket ticket = new Ticket(address(identity), address(organizers), address(0));

        uint256 runtime = address(ticket).code.length;
        uint256 initcode = type(Ticket).creationCode.length;

        assertLt(runtime, MONAD_CODE_SIZE_LIMIT, "Ticket runtime crossed Monad's limit");
        assertLt(initcode, MONAD_CODE_SIZE_LIMIT, "Ticket initcode crossed Monad's limit");

        emit log_named_uint("Ticket runtime size (B)", runtime);
        emit log_named_uint("Ticket initcode size (B)", initcode);
        emit log_named_uint("Monad margin, runtime (B)", MONAD_CODE_SIZE_LIMIT - runtime);
        emit log_named_uint("Monad margin, initcode (B)", MONAD_CODE_SIZE_LIMIT - initcode);
    }

    /// @dev 나머지 셋도 같이 기록한다. 커지는 방향을 놓치지 않기 위한 것이지 한도 걱정은 아니다.
    ///      단언은 넷 모두에 건다 — .github-checks.sh 가 --sizes 를 더는 돌리지 않으므로,
    ///      어느 컨트랙트가 Monad 한도를 넘는지 보는 곳이 이 파일 말고는 없다.
    function test_theOtherThreeAreNowhereNearTheLimit() public {
        Identity identity = new Identity(address(0xA11CE));
        Organizers organizers = new Organizers(address(0));
        // 페이마스터의 생성자는 0 이 아닌 네 주소만 요구한다. 크기를 재는 데에는 목이면 충분하다.
        MontiPaymaster paymaster = new MontiPaymaster(
            IEntryPoint(address(0xE41)),
            IOrganizers(address(organizers)),
            ITicket(address(0x71C)),
            IIdentity(address(identity))
        );

        emit log_named_uint("Identity runtime size (B)", address(identity).code.length);
        emit log_named_uint("Organizers runtime size (B)", address(organizers).code.length);
        emit log_named_uint("MontiPaymaster runtime size (B)", address(paymaster).code.length);
        emit log_named_uint("Identity initcode size (B)", type(Identity).creationCode.length);
        emit log_named_uint("Organizers initcode size (B)", type(Organizers).creationCode.length);
        emit log_named_uint("MontiPaymaster initcode size (B)", type(MontiPaymaster).creationCode.length);

        assertLt(address(identity).code.length, MONAD_CODE_SIZE_LIMIT);
        assertLt(address(organizers).code.length, MONAD_CODE_SIZE_LIMIT);
        assertLt(address(paymaster).code.length, MONAD_CODE_SIZE_LIMIT);
        assertLt(type(Identity).creationCode.length, MONAD_CODE_SIZE_LIMIT);
        assertLt(type(Organizers).creationCode.length, MONAD_CODE_SIZE_LIMIT);
        assertLt(type(MontiPaymaster).creationCode.length, MONAD_CODE_SIZE_LIMIT);
    }
}
