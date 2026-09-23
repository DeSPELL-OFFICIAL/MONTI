// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {P256} from "solady/utils/P256.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @dev Under the repo's `evm_version = "osaka"`, forge ships the real EIP-7951 P256VERIFY
///      precompile at 0x100, so these tests exercise the real precompile against real vectors.
///
///      문 테스트의 서명은 이제 vm.signP256 이 그 자리에서 만든다(다이제스트가 배포본 주소에
///      묶였으므로 상수로 둘 수 없다). 그 서명자를 믿어도 되는 이유가 이 파일에 있다: 같은
///      다이제스트에 대해 Foundry 의 서명자와 noble 이 **글자 그대로 같은 r, s** 를 낸다.
contract P256VectorsTest is MontiTest {
    function setUp() public {
        _deployMonti();
    }

    function test_precompile_acceptsDeviceVector() public view {
        assertTrue(
            P256.verifySignature(
                P256Vectors.SHARED_DIGEST,
                P256Vectors.SHARED_R,
                P256Vectors.SHARED_S,
                P256Vectors.DEVICE_X,
                P256Vectors.DEVICE_Y
            )
        );
    }

    function test_precompile_rejectsOtherKey() public view {
        assertFalse(
            P256.verifySignature(
                P256Vectors.SHARED_DIGEST,
                P256Vectors.SHARED_OTHER_R,
                P256Vectors.SHARED_OTHER_S,
                P256Vectors.DEVICE_X,
                P256Vectors.DEVICE_Y
            )
        );
    }

    /// @dev 파생된 서명이 생성된 서명만큼 믿을 만하다는 근거. 두 구현(Foundry 의 Rust p256 과
    ///      script/gen-p256-vectors.mjs 의 noble curves)이 같은 키·같은 다이제스트에서 같은
    ///      답을 낸다 -- RFC 6979 결정적 nonce 와 low-s 정규화까지 포함해서.
    function test_foundrySignerAgreesWithTheGeneratedVector() public {
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, P256Vectors.SHARED_DIGEST);
        assertEq(r, P256Vectors.SHARED_R, "r");
        assertEq(s, P256Vectors.SHARED_S, "s");
        assertLt(uint256(s), P256.N / 2, "and it is the low-s half, which C2 requires");
    }

    /// @dev 고정 벡터. 체인과 배포본까지 숫자로 박아 두었으므로 packages/shared 와 03 의
    ///      클라이언트가 이 hex 하나로 자기 구현을 검증할 수 있다. 여기서 block.chainid 나
    ///      address(ticket) 을 쓰면 안 된다 -- 그러면 고정 벡터가 아니게 된다.
    ///
    ///      한 워드라도 어긋나면 현장에서 나타나는 증상은 DENY DEVICE_MISMATCH 다.
    function test_digest_matchesSharedVector() public pure {
        bytes32 onChain = sha256(
            abi.encode(
                P256Vectors.SHARED_CHAIN_ID,
                P256Vectors.SHARED_TICKET,
                P256Vectors.SHARED_TOKEN_ID,
                P256Vectors.SHARED_GATE_ID,
                P256Vectors.SHARED_EVENT_ID,
                P256Vectors.SHARED_NONCE,
                P256Vectors.SHARED_ISSUED_AT
            )
        );
        assertEq(onChain, P256Vectors.SHARED_DIGEST);
    }

    /// @dev 옛 5필드 다이제스트와 다른 값이어야 한다. 같다면 도메인 묶음이 아무 일도 안 한 것이다.
    function test_digest_isNotTheOldFiveFieldOne() public pure {
        bytes32 old5 = sha256(
            abi.encode(
                P256Vectors.SHARED_TOKEN_ID,
                P256Vectors.SHARED_GATE_ID,
                P256Vectors.SHARED_EVENT_ID,
                P256Vectors.SHARED_NONCE,
                P256Vectors.SHARED_ISSUED_AT
            )
        );
        assertTrue(old5 != P256Vectors.SHARED_DIGEST, "the two domain words must change the hash");
    }
}
