// 게이트 콘솔의 화면 조각 한 묶음. 전부 **순수 표시용**이다 — 상태 기계도, 타이머도, 네트워크도
// 여기에 없다(`OverrideDialog` 의 입력 두 칸만이 예외이고, 그것도 자기 입력을 담아둘 뿐이다).
//
// 스타일은 여기서 한 번만 불러온다. 조각마다 각자 `import './console.css'` 를 쓰면 번들러가
// 중복을 지워주긴 해도, 어느 조각이 스타일 없이 쓰일 수 있는지가 불분명해진다. 이 배럴을 거쳐
// 가져가는 한 화면은 언제나 스타일과 함께 온다.
// 토큰이 먼저다. `console.css` 는 `--bg`·`--text`·`--accent`·`.btn` 을 그대로 쓰는데, 그것들을
// 들여오는 곳은 지금까지 관객 진입점(`App.tsx`) 하나뿐이었다 — 스태프 APK(`staffMain.tsx`)는
// 들여오지 않는다. 그래서 콘솔이 스스로 가져온다. 같은 파일이라 번들러가 한 번만 싣고, 덕분에
// 이 배럴을 쓰는 화면은 어느 빌드에 실리든 토큰 없이 렌더되지 않는다.
import '../../shared/theme.css';
import './console.css';

export { StaffShell, type StaffShellProps } from './StaffShell';
export { TapPrompt, type TapPromptProps } from './TapPrompt';
export { ReceivedCard, type ReceivedCardProps } from './ReceivedCard';
export { ConfirmingCard, type ConfirmingCardProps } from './ConfirmingCard';
export { AdmitCard, type AdmitCardProps } from './AdmitCard';
export { OfflineAdmitCard, type OfflineAdmitCardProps } from './OfflineAdmitCard';
export { DenyCard, type DenyCardProps } from './DenyCard';
export { RefusedToast, type RefusedToastProps } from './RefusedToast';
export { LastTapChip, type LastTapChipProps } from './LastTapChip';
export { OfflineBadge, type OfflineBadgeProps } from './OfflineBadge';
export { QueueBanner, type QueueBannerProps } from './QueueBanner';
export { StaleDoorBanner, type StaleDoorBannerProps } from './StaleDoorBanner';
export { OverrideDialog, type OverrideDialogProps } from './OverrideDialog';
