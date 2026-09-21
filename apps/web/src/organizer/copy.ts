import { useLocale } from '../shared/i18n';

/**
 * The organiser's own copy, in both locales. It is kept out of `shared/copy` because the
 * attendee copy lint (`pnpm lint:copy`) does not read this folder: an organiser is allowed the
 * one sentence below about paying a fee themselves, which no attendee screen may ever say.
 *
 * Everything else here still avoids that vocabulary, because an organiser is a person putting
 * on a concert, not an operator of anything.
 */
const ko = {
  wizard: {
    heading: '행사 만들기',
    step1: '기본 정보', step2: '일시·장소', step3: '티켓 종류', step4: '판매·양도 규칙',
    step5: '게이트·스태프', step6: '검토·발행',
    stepOf: '{{step}}단계 / 6단계',
    next: '다음', back: '이전', saveDraft: '초안은 이 기기에 자동으로 저장돼요', startOver: '처음부터 다시',

    orgId: '조직 번호', orgIdHelp: '행사를 여는 조직의 번호예요. 모르면 담당자에게 물어보세요',
    title: '제목', description: '소개글',
    image: '대표 이미지 (1200×630 권장)',
    imagePick: '이미지 고르기', imagePicked: '{{name}} 을(를) 골랐어요', imageWorking: '이미지를 준비하고 있어요',
    imageHelp: 'JPG·PNG·WebP만 올릴 수 있어요. 큰 사진은 자동으로 줄여요',
    category: '분류', region: '지역',
    category0: '공연', category1: '모임', category2: '전시', category3: '기타',

    venue: '장소', startsAt: '시작', endsAt: '종료',
    saleStart: '신청 시작', saleEnd: '신청 종료',

    tierName: '종류 이름', supply: '수량', maxPerWallet: '1인 최대 보유 수', seated: '좌석 지정',
    addTier: '종류 추가', removeTier: '삭제',
    tiersHelp: '지금은 무료 티켓만 만들 수 있어요. 종류는 8개까지예요',

    transferable: '양도 허용', cutoff: '양도 마감 (공연 N시간 전)', maxTransfers: '티켓당 양도 횟수',
    approvalRequired: '참가 승인제',
    approvalWarning: '승인제를 켜면 지금은 아무도 티켓을 받을 수 없어요. 끄고 발행해 주세요',
    requireKyc: '본인인증 필수 (암표 방지)',
    requireKycHelp: '켜면 신분증·얼굴 확인을 마친 사람만 티켓을 받을 수 있어요. 가벼운 모임은 꺼두세요',

    gateName: '입구 이름', addGate: '입구 추가', removeGate: '삭제',
    gatesHelp: '발행한 뒤 행사 화면에서 단말기를 이 이름에 연결해요. 단말기 등록은 그때 합니다',
    gatesEmpty: '아직 적어 둔 입구가 없어요',

    reviewTitle: '이대로 기록할게요',
    reviewHashed: '제목·소개글·장소는 그대로가 아니라 요약값으로 기록돼요. 읽을 수 있는 원문은 이미지와 함께 따로 올라갑니다',
    feeNote: '발행 비용은 MONTI가 대신 냅니다',
    publish: '발행하기', publishing: '발행하고 있어요', pinning: '이미지와 소개글을 올리고 있어요',
    confirming: '아직 확인 중이에요. 잠시 뒤 행사 목록에서 확인해 주세요',
    published: '발행했습니다',

    // 운영자에게만 보이는 안내라 '지갑'을 쓸 수 있는 유일한 문구다(01b 재배포 전까지).
    unsponsored: '주최자 작업은 지금은 수수료 지갑이 필요해요',
    unsponsoredHelp: '다음 업데이트가 끝나면 MONTI가 대신 내드려요. 그때까지는 담당자에게 문의해 주세요',
    failed: '발행하지 못했어요. 잠시 뒤 다시 시도해 주세요',
    fixFirst: '아래를 먼저 고쳐 주세요',

    problems: {
      orgId: '조직 번호를 1 이상의 숫자로 적어 주세요',
      title: '제목을 적어 주세요',
      description: '소개글을 적어 주세요',
      image: '대표 이미지를 골라 주세요',
      venue: '장소를 적어 주세요',
      region: '지역을 목록에서 골라 주세요',
      category: '분류를 목록에서 골라 주세요',
      schedule: '종료 시각이 시작 시각보다 뒤여야 해요',
      sale: '신청 종료가 신청 시작보다 뒤여야 해요',
      cutoff: '양도 마감 시간을 0시간 이상으로 적어 주세요',
      maxTransfers: '양도 횟수를 0회에서 255회 사이로 적어 주세요',
      tiersEmpty: '티켓 종류를 하나 이상 만들어 주세요',
      tiersTooMany: '티켓 종류는 8개까지예요',
      tierName: '모든 티켓 종류에 이름을 적어 주세요',
      tierSupply: '수량을 1장 이상으로 적어 주세요',
      tierMaxPerWallet: '1인 최대 보유 수를 1장에서 65535장 사이로 적어 주세요',
      imageType: 'JPG·PNG·WebP 이미지만 올릴 수 있어요',
      imageTooLarge: '이미지가 너무 커요. 더 작은 사진으로 골라 주세요',
      notYourOrg: '이 조직의 행사를 만들 권한이 없어요',
      pinFailed: '이미지를 올리지 못했어요. 잠시 뒤 다시 시도해 주세요',
    },
  },
};

const en: typeof ko = {
  wizard: {
    heading: 'Create an event',
    step1: 'Basics', step2: 'When and where', step3: 'Ticket kinds', step4: 'Sale and hand-over',
    step5: 'Entrances and staff', step6: 'Review and publish',
    stepOf: 'Step {{step}} of 6',
    next: 'Next', back: 'Back', saveDraft: 'Your draft is saved on this device automatically',
    startOver: 'Start over',

    orgId: 'Organisation number', orgIdHelp: 'The number of the organisation putting this on. Ask your contact if you are not sure',
    title: 'Title', description: 'About this event',
    image: 'Cover image (1200×630 recommended)',
    imagePick: 'Choose an image', imagePicked: 'Chose {{name}}', imageWorking: 'Getting the image ready',
    imageHelp: 'JPG, PNG or WebP only. A big photo is shrunk for you',
    category: 'Theme', region: 'Region',
    category0: 'Concert', category1: 'Meetup', category2: 'Exhibition', category3: 'Other',

    venue: 'Venue', startsAt: 'Starts', endsAt: 'Ends',
    saleStart: 'Sign-ups open', saleEnd: 'Sign-ups close',

    tierName: 'Kind', supply: 'How many', maxPerWallet: 'Most one person may hold', seated: 'Assigned seating',
    addTier: 'Add a kind', removeTier: 'Remove',
    tiersHelp: 'Free tickets only for now. Up to eight kinds',

    transferable: 'Allow handing over', cutoff: 'Hand-over closes (hours before the event)',
    maxTransfers: 'Hand-overs per ticket',
    approvalRequired: 'Approve each attendee',
    approvalWarning: 'With approval on, nobody can get a ticket yet. Turn it off before publishing',
    requireKyc: 'Require identity check (stops resellers)',
    requireKycHelp: 'With this on, only people who finished the ID and face check can get a ticket. Leave it off for casual meetups',

    gateName: 'Entrance name', addGate: 'Add an entrance', removeGate: 'Remove',
    gatesHelp: 'After publishing, you link each terminal to one of these names on the event screen. Terminals are registered there, not here',
    gatesEmpty: 'No entrances written down yet',

    reviewTitle: 'This is what gets recorded',
    reviewHashed: 'The title, the description and the venue are recorded as a summary value rather than as text. The readable originals are published alongside the image',
    feeNote: 'MONTI covers the cost of publishing',
    publish: 'Publish', publishing: 'Publishing', pinning: 'Uploading the image and the description',
    confirming: 'Still confirming. Check your event list again in a moment',
    published: 'Published',

    // Organiser-only notice: the one place this app is allowed that vocabulary (until 01b).
    unsponsored: 'Organiser actions still need a fee wallet for now',
    unsponsoredHelp: 'MONTI will cover them once the next update is out. Until then, ask your contact',
    failed: 'Could not publish. Please try again in a moment',
    fixFirst: 'Please fix these first',

    problems: {
      orgId: 'Write the organisation number as a whole number of 1 or more',
      title: 'Please write a title',
      description: 'Please write a description',
      image: 'Please choose a cover image',
      venue: 'Please write the venue',
      region: 'Please pick a region from the list',
      category: 'Please pick a theme from the list',
      schedule: 'The end has to come after the start',
      sale: 'Sign-ups have to close after they open',
      cutoff: 'Write the hand-over cut-off as 0 hours or more',
      maxTransfers: 'Write hand-overs per ticket as a number from 0 to 255',
      tiersEmpty: 'Add at least one ticket kind',
      tiersTooMany: 'Up to eight ticket kinds',
      tierName: 'Give every ticket kind a name',
      tierSupply: 'Write how many as 1 or more',
      tierMaxPerWallet: 'Write the per-person limit as a number from 1 to 65535',
      imageType: 'JPG, PNG and WebP images only',
      imageTooLarge: 'That image is too big. Please choose a smaller photo',
      notYourOrg: 'You may not create events for this organisation',
      pinFailed: 'Could not upload the image. Please try again in a moment',
    },
  },
};

export type OrganizerCopy = typeof ko;
export const organizerCopy = { ko, en };

/** Typed organiser copy for the current locale. Re-renders when the language changes. */
export function useOrganizerCopy(): OrganizerCopy {
  return useLocale() === 'en' ? en : ko;
}
