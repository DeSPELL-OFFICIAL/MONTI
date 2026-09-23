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
  home: {
    title: '주최자',
    backToDiscover: '탐색으로',

    orgs: '내 주최사',
    org: '주최사',
    orgsEmpty: '아직 속한 주최사가 없어요.',
    become: '주최사 만들기',
    // 콜러블이 답한 번호가 인덱서에 오르기까지 1~2초가 걸린다. 그 사이에 여기로 오면 목록에 없다.
    orgPending: '방금 만든 주최사는 잠시 뒤에 목록에 나타나요',
    noPermission: '행사를 만들 권한이 없어요. 주최사 오너에게 권한을 요청해 주세요',

    events: '내 행사',
    eventsEmpty: '아직 만든 행사가 없어요. 아래 만들기로 시작해 보세요',
    eventsFailed: '내 행사를 가져오지 못했어요. 잠시 뒤 다시 시도해 주세요',
    // 목록은 체인 줄만 읽는다. 제목은 IPFS에 있고, 느린 게이트웨이가 목록을 붙잡으면 안 된다.
    eventFallback: '행사 #{{id}}',
    status: { Draft: '초안', Published: '발행됨', Cancelled: '취소됨' },

    create: '만들기',
    retry: '다시 시도',

    manual: '행사 번호로 열기',
    eventId: '행사 번호',
    open: '열기',
    team: '팀',
    orgId: '조직 번호',
    // 체인에는 이름이 없다. orgProfiles 문서가 없는 조직은 번호로 부른다.
    orgFallback: '주최사 #{{id}}',
  },

  become: {
    title: '주최사 만들기',
    name: '주최사 이름',
    // 이름은 화면에 보여 주기 위한 것뿐이다. 서버가 orgProfiles 문서에 적고, 목록이 그것을 읽는다.
    nameHelp: '목록과 행사 화면에 보여 줄 이름이에요. 지금은 나중에 고칠 수 없으니 한 번에 정확히 적어 주세요',
    create: '만들기',
    // 콜러블은 영수증까지 기다렸다가 답한다. 보통 2~5초, 드물게 10초가 넘는다.
    working: '만들고 있어요',
    cancel: '취소',
    // 가입이 끝나지 않은 두 경우에만 뜨는 이어가기 버튼.
    resume: '가입 이어서 하기',
    problems: {
      notActive: '가입을 먼저 마무리해 주세요',
      noSignup: '가입을 먼저 마무리해 주세요',
      // 한 사람이 만들 수 있는 주최사는 3개다. 네 번째는 서버가 보내기 전에 거절한다.
      limit: '주최사는 3개까지 만들 수 있어요',
      badName: '이름을 2자에서 40자 사이로 적어 주세요',
    },
  },

  lifecycle: {
    publish: '발행하기',
    publishConfirm: '발행하면 누구나 이 행사를 보고 신청할 수 있어요. 발행한 뒤에는 내용을 고칠 수 없어요',
    cancel: '행사 취소하기',
    // 01b 재배포 뒤에는 취소된 행사의 티켓을 남에게 넘길 수 없다. 확인 창에서 미리 말해 둔다.
    cancelConfirm: '취소하면 되돌릴 수 없어요. 신청이 닫히고, 이미 나간 티켓은 다음 업데이트부터 남에게 넘길 수 없게 돼요',
    confirm: '네, 진행할게요',
    back: '아니요',
    working: '보내고 있어요',
    published: '발행했어요',
    cancelled: '취소했어요',
    confirming: '아직 확인 중이에요. 잠시 뒤 이 화면을 다시 열어 주세요',
    notDraft: '이미 발행한 행사예요',
    closed: '이미 끝났거나 취소된 행사예요',
    notAllowed: '이 행사를 다룰 권한이 없어요',
    failed: '보내지 못했어요. 잠시 뒤 다시 시도해 주세요',
  },

  gates: {
    title: '입구 단말기',
    pending: '승인을 기다리는 단말기',
    none: '승인을 기다리는 단말기가 없어요',
    register: '등록',
    registered: '등록한 단말기',
    noneRegistered: '아직 등록한 단말기가 없어요',
    open: '열기',
    close: '닫기',
    revoke: '폐기',
    isOpen: '열림',
    isClosed: '닫힘',
    isRevoked: '폐기됨',
    gateId: '단말기 번호',
    submittedAt: '올라온 시각',
    manual: '직접 옮겨 적기',
    manualHelp: '스태프 앱이 올린 줄이 안 보이면 단말기 화면의 값을 그대로 옮겨 적으세요',
    account: '단말기 주소',
    kx: '키 X',
    ky: '키 Y',
    working: '보내고 있어요',
    done: '보냈어요',
    problems: {
      account: '단말기 주소를 0x로 시작하는 42자로 옮겨 적어 주세요',
      key: '키 값을 0x로 시작하는 66자로 옮겨 적어 주세요',
      // 컨트랙트는 두 쪽이 모두 0일 때만 막는다. 한 쪽만 0인 키는 그대로 올라가고,
      // 그 단말기는 어떤 입장도 확인하지 못한다 — 그래서 여기서 막는다.
      halfZero: '키 한 쪽이 비어 있어요. 단말기에서 키를 다시 만들어 주세요',
      inUse: '이 단말기는 이미 다른 행사에 등록돼 있어요',
      unknownGate: '없는 단말기 번호예요',
      unknownEvent: '없는 행사 번호예요',
      alreadyRevoked: '이미 폐기한 단말기예요',
      notAllowed: '이 행사의 입구를 관리할 권한이 없어요',
      failed: '보내지 못했어요. 잠시 뒤 다시 시도해 주세요',
    },
  },

  team: {
    title: '팀',
    invite: '초대하기',
    phone: '휴대폰 번호',
    role: '역할',
    admin: '관리자',
    manager: '매니저',
    canApprove: '입장 예외를 직접 승인할 수 있어요',
    requestOnly: '입장 예외는 요청만 할 수 있어요',
    perms: {
      createEvent: '행사 만들기·공지',
      manageGates: '입구 단말기 관리',
      approveOverride: '입장 예외 승인',
      manageManagers: '매니저 관리',
      manageBudget: '비용 관리',
    },
    invited: '초대장을 만들었어요. 아래 링크를 본인에게 보내 주세요',
    link: '초대 링크',
    linkOnce: '초대 링크는 방금 만든 초대에만 보여요. 다시 필요하면 새로 만들어 주세요',
    revoke: '초대 거두기',
    invites: '초대 목록',
    invitesLoading: '초대 목록을 불러오고 있어요',
    invitesEmpty: '아직 만든 초대가 없어요',
    invitesNotAllowed: '초대 목록은 조직의 오너나 매니저 관리 권한이 있는 사람만 볼 수 있어요',
    createdAt: '만든 시각',
    expiresAt: '기한',
    requiredSender: '이 계정으로 보내야 해요',
    status: {
      sent: '보냈어요',
      accepted: '수락했어요',
      revoked: '거둔 초대',
      expired: '기한이 지났어요',
    },
    grant: '역할 올리기',
    grantClose: '닫기',
    grantHelp: '초대를 받은 사람이 알려 준 계정 주소를 적어 주세요. 이 마지막 한 단계는 조직의 오너만 보낼 수 있어요',
    account: '계정 주소',
    granted: '역할이 올라갔어요',
    working: '보내고 있어요',
    check: '지금 확인',
    notOwner: '조직의 오너만 역할을 올릴 수 있어요',
    problems: {
      orgId: '조직 번호를 1 이상의 숫자로 적어 주세요',
      phone: '휴대폰 번호를 +8210으로 시작하는 국제 형식으로 적어 주세요',
      account: '계정 주소를 0x로 시작하는 42자로 옮겨 적어 주세요',
      bits: '권한을 하나 이상 골라 주세요',
      notAllowed: '이 조직에 사람을 더할 권한이 없어요',
      notOwner: '조직의 오너만 보낼 수 있는 작업이에요',
      unknownOrg: '없는 조직 번호예요',
      notFound: '없는 초대장이에요',
      failed: '보내지 못했어요. 잠시 뒤 다시 시도해 주세요',
    },
  },

  invite: {
    title: '초대 받기',
    working: '초대장을 확인하고 있어요',
    accepted: '초대를 받았어요',
    ownerMustSend: '마지막 한 단계는 조직의 오너가 보내야 해요. 아래 내 계정 주소를 오너에게 알려 주세요',
    owner: '오너 주소',
    yourAccount: '내 계정 주소',
    role: '역할',
    orgId: '조직 번호',
    check: '지금 확인',
    done: '역할이 올라갔어요',
    waiting: '오너가 보내면 여기가 완료로 바뀌어요',
    problems: {
      notForYou: '이 초대는 다른 번호로 보낸 거예요',
      used: '이미 다른 사람이 받은 초대예요',
      expired: '기한이 지난 초대예요',
      notFound: '없는 초대장이에요',
      noPhone: '먼저 휴대폰 번호 인증을 끝내 주세요',
      failed: '초대장을 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요',
    },
  },

  dashboard: {
    title: '행사 현황',
    sold: '신청',
    remaining: '남음',
    checkins: '입장',
    attendees: '참석자',
    none: '아직 신청한 사람이 없어요',
    kyc: '본인인증',
    kycYes: '완료',
    kycNo: '안 함',
    checkedIn: '입장함',
    notCheckedIn: '아직',
    gates: '입구 단말기',
    notIndexed: '없는 행사 번호이거나 아직 색인 전이에요',
    failed: '현황을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요',
  },

  announce: {
    title: '공지',
    placeholder: '공지 내용 (최대 500자)',
    post: '공지 올리기',
    posting: '올리고 있어요',
    posted: '올린 공지',
    loading: '공지를 불러오고 있어요',
    none: '아직 올린 공지가 없어요',
    loadFailed: '이미 올린 공지를 불러오지 못했어요. 방금 올린 공지만 아래에 보여요',
    tooLong: '500자까지 올릴 수 있어요',
    notAllowed: '이 행사에 공지를 올릴 권한이 없어요',
    chatClosed: '행사가 끝나 대화방이 닫혔어요',
    failed: '공지를 올리지 못했어요. 잠시 뒤 다시 시도해 주세요',
  },

  /**
   * The creation scene: one scroll for the event, one for the tickets, and a done screen.
   * It replaces the six-step wizard below, which stays reachable at `/org/new/old` until
   * T-EV-W10 deletes it.
   */
  scene: {
    title: '행사 만들기',
    leave: '나가기',
    resumed: '이어서 쓰는 중',
    startOver: '처음부터',
    next: '다음',
    back: '행사 정보로',

    saveAuto: '적는 대로 저장돼요',
    saving: '저장 중…',
    saveFailed: '저장 안 됨 · 다시 시도',
    savedNow: '저장됨 · 방금',
    savedAgo: '저장됨 · {{ago}}',
    agoMinutes: '{{count}}분 전',
    agoHours: '{{count}}시간 전',

    poster: '포스터',
    posterEmpty: '포스터를 올리면 여기에 보여요',
    posterChange: '포스터 바꾸기',
    posterWorking: '포스터를 올리고 있어요',
    posterAlt: '포스터 미리보기',

    titleLabel: '제목',
    titlePlaceholder: '무슨 행사인가요?',
    themeLabel: '테마',
    theme0: '공연', theme1: '모임', theme2: '전시', theme3: '기타',
    tagsLabel: '태그',
    tagsHelp: '5개까지, 하나에 12자까지 적을 수 있어요. 탭하면 빼요',
    tagPlaceholder: '예: 재즈',
    tagAdd: '태그 더하기',
    tagRemove: '{{tag}} 빼기',
    bodyLabel: '소개',
    bodyPlaceholder: '어떤 행사인지 알려주세요',
    count: '{{count}}/{{max}}',

    placeLabel: '장소',
    regionLabel: '지역',
    venuePlaceholder: '장소 이름이나 주소',
    timeLabel: '시간',
    startsAt: '시작',
    endsAt: '종료',
    holdersOnly: '티켓 소지자에게만 공개',
    // 백엔드 T-EV-B 보고 9.3: 숨김 → 공개는 언제든 되지만 그 반대는 안 된다.
    venueHiddenHelp: '탐색 화면에는 지역만 보여요. 자세한 장소는 티켓을 받은 사람에게만 알려줘요',
    venueHiddenOneWay: '공개로 두고 만들면 나중에는 숨길 수 없어요. 숨겨 두었다가 공개로 바꾸는 건 언제든 돼요',
    timeHiddenHelp: '탐색 화면에는 날짜만 보여요. 시작 시각은 티켓을 받은 사람에게만 알려줘요',
    saleHelp: '신청은 행사를 만든 순간 열리고 행사가 끝날 때 닫혀요',

    problems: {
      poster: '포스터를 올려 주세요',
      title: '제목을 2자에서 60자 사이로 적어 주세요',
      tags: '태그는 5개까지, 하나에 12자까지예요',
      body: '소개를 2000자 안으로 적어 주세요',
      region: '지역을 골라 주세요',
      venue: '장소를 적어 주세요',
      venueTooLong: '장소는 200자 안으로 적어 주세요',
      startsAt: '시작 시각을 골라 주세요',
      endsAt: '종료 시각을 골라 주세요',
      schedule: '종료 시각이 시작 시각보다 뒤여야 해요',
    },


    tiers: {
      title: '티켓',
      create: '행사 만들기',
      add: '종류 추가',
      remove: '빼기',
      kind: '{{index}}번째 종류',
      name: '이름',
      namePlaceholder: '예: 일반',
      supply: '수량',
      maxPerWallet: '1인당 한도',
      price: '가격',
      free: '무료',
      amount: '금액',
      art: '티켓 그림',
      // 'Mint' 는 관객 금지어(`mint`)에 걸린다 — 색 이름은 '청록'/'Teal' 로 둔다.
      artA: '오로라', artB: '잉걸', artC: '청록', artD: '어스름',
      artUpload: '직접 올리기',
      artUploadClose: '그만두기',
      artWorking: '그림을 올리고 있어요',
      // 유료 종류를 고른 그 자리에서 막는다 — 마지막에 거절당하는 게 제일 나쁘다(계획 B-3).
      paidBlocked: '유료 티켓은 곧 열려요. 지금은 무료로만 만들 수 있어요',
      rules: '행사 전체 규칙',
      // transferable·transferCutoffSeconds·requireKyc 는 EventMeta 에 있고 Tier 에는 없다.
      // 종류 카드 안에 두면 화면이 거짓말을 한다.
      rulesHelp: '이 세 가지는 종류마다 다르게 둘 수 없어요. 행사 하나에 하나씩이에요',
      transferable: '양도 가능',
      cutoff: '양도 마감 (행사 시작 N시간 전)',
      requireKyc: '본인 확인한 사람만',
      requireKycHelp: '켜면 신분증·얼굴 확인을 마친 사람만 티켓을 받을 수 있어요. 가벼운 모임은 꺼두세요',
      feeNote: '만드는 비용은 MONTI가 대신 내요',
    },


    publish: {
      pinning: '행사 정보를 올리고 있어요',
      sending: '행사를 만들고 있어요',
      finishing: '마무리하고 있어요',
      // 시간 초과는 실패가 아니다. 두 번 보내면 행사가 두 개가 된다.
      confirming: '만드는 중이에요. 화면을 나가도 돼요. 잠시 뒤 주최자 화면에서 확인해 주세요',
    },

    publishProblems: {
      notYourOrg: '이 주최사에서 행사를 만들 권한이 없어요',
      pinFailed: '지금은 저장할 수 없어요. 잠시 뒤 다시 시도해 주세요',
      badMeta: '제목이나 소개가 너무 길어요. 줄이고 다시 시도해 주세요',
      badTags: '태그를 다시 확인해 주세요',
      badPoster: '포스터를 다시 올려 주세요',
      schedule: '종료 시각이 시작 시각보다 뒤여야 해요',
      tiersEmpty: '티켓 종류를 하나 이상 만들어 주세요',
      failed: '행사를 만들지 못했어요. 잠시 뒤 다시 시도해 주세요',
    },

    tierProblems: {
      eventIncomplete: '행사 정보에 아직 빠진 칸이 있어요',
      tiersTooMany: '종류는 8개까지예요',
      tierName: '모든 종류에 이름을 적어 주세요',
      tierSupply: '수량을 1장 이상으로 적어 주세요',
      tierMaxPerWallet: '1인당 한도를 1장에서 65535장 사이로 적어 주세요',
      cutoff: '양도 마감 시간을 0시간 이상으로 적어 주세요',
      paidTier: '무료가 아닌 종류가 있어요. 무료로 바꾸면 만들 수 있어요',
    },

    imageProblems: {
      tooLarge: '사진이 너무 커요. 다른 사진을 골라 주세요',
      format: 'JPG·PNG 사진만 올릴 수 있어요',
      dimensions: '사진이 너무 커요. 한 변이 4000픽셀 안이어야 해요',
      quota: '오늘은 사진을 더 올릴 수 없어요. 내일 다시 시도해 주세요',
      notActive: '가입을 먼저 마무리해 주세요',
      failed: '사진을 올리지 못했어요. 잠시 뒤 다시 시도해 주세요',
    },
  },

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
    openEvent: '행사 화면 열기',

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
      venueTooLong: '장소는 200자 안으로 적어 주세요',
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
  home: {
    title: 'Organiser',
    backToDiscover: 'Back to explore',

    orgs: 'My organisers',
    org: 'Organiser',
    orgsEmpty: 'You do not belong to an organiser yet.',
    become: 'Create an organiser',
    // The callable answers with the number a second or two before the indexer lists it.
    orgPending: 'An organiser you just created appears in this list in a moment',
    noPermission: 'You may not create events. Ask the organiser owner to give you the permission',

    events: 'My events',
    eventsEmpty: 'No events yet. Start one with Create below',
    eventsFailed: 'Could not load your events. Please try again in a moment',
    // The list reads the indexed rows only. Titles live on IPFS, and a slow gateway must not
    // hold up rows that are already in hand.
    eventFallback: 'Event #{{id}}',
    status: { Draft: 'Draft', Published: 'Published', Cancelled: 'Cancelled' },

    create: 'Create',
    retry: 'Try again',

    manual: 'Open by event number',
    eventId: 'Event number',
    open: 'Open',
    team: 'Team',
    orgId: 'Organisation number',
    // The chain holds no name. An organisation with no orgProfiles document goes by number.
    orgFallback: 'Organiser #{{id}}',
  },

  become: {
    title: 'Create an organiser',
    name: 'Organiser name',
    // The name is for showing only: the server writes it to orgProfiles and the lists read it.
    nameHelp: 'The name shown in your lists and on your event screens. It cannot be edited afterwards for now, so please get it right the first time',
    create: 'Create',
    // The callable waits for the receipt before it answers: usually 2-5 seconds, sometimes more.
    working: 'Creating',
    cancel: 'Cancel',
    // Offered for the two refusals that really mean "your signup is not finished".
    resume: 'Finish signing up',
    problems: {
      notActive: 'Please finish signing up first',
      noSignup: 'Please finish signing up first',
      // Three per person. The fourth is refused before anything is sent.
      limit: 'You can create up to three organisers',
      badName: 'Write a name of 2 to 40 characters',
    },
  },

  lifecycle: {
    publish: 'Publish',
    publishConfirm: 'Once published, anyone can see this event and sign up. You cannot change the details afterwards',
    cancel: 'Cancel this event',
    // After the 01b redeploy a cancelled event's tickets can no longer be handed over.
    cancelConfirm: 'Cancelling cannot be undone. Sign-ups close, and from the next update on nobody can hand an issued ticket to somebody else',
    confirm: 'Yes, go ahead',
    back: 'No',
    working: 'Sending',
    published: 'Published',
    cancelled: 'Cancelled',
    confirming: 'Still confirming. Please open this screen again in a moment',
    notDraft: 'This event is already published',
    closed: 'This event is already over or cancelled',
    notAllowed: 'You may not manage this event',
    failed: 'Could not send that. Please try again in a moment',
  },

  gates: {
    title: 'Entry terminals',
    pending: 'Terminals waiting for approval',
    none: 'No terminal is waiting for approval',
    register: 'Approve',
    registered: 'Approved terminals',
    noneRegistered: 'No terminal approved yet',
    open: 'Open',
    close: 'Close',
    revoke: 'Retire',
    isOpen: 'Open',
    isClosed: 'Closed',
    isRevoked: 'Retired',
    gateId: 'Terminal number',
    submittedAt: 'Sent at',
    manual: 'Type it in instead',
    manualHelp: 'If the staff app\'s entry is not listed, copy the values from the terminal screen exactly',
    account: 'Terminal address',
    kx: 'Key X',
    ky: 'Key Y',
    working: 'Sending',
    done: 'Sent',
    problems: {
      account: 'Copy the terminal address as 42 characters starting with 0x',
      key: 'Copy the key as 66 characters starting with 0x',
      // The contract only refuses a key whose halves are BOTH zero. A half-zero key is
      // accepted and then verifies no entry at all, so it is refused here instead.
      halfZero: 'One half of the key is empty. Please make the key again on the terminal',
      inUse: 'This terminal is already approved for another event',
      unknownGate: 'No terminal has that number',
      unknownEvent: 'No event has that number',
      alreadyRevoked: 'That terminal is already retired',
      notAllowed: 'You may not manage the entrances of this event',
      failed: 'Could not send that. Please try again in a moment',
    },
  },

  team: {
    title: 'Team',
    invite: 'Invite',
    phone: 'Mobile number',
    role: 'Role',
    admin: 'Admin',
    manager: 'Manager',
    canApprove: 'May approve entry exceptions directly',
    requestOnly: 'May only file entry exception requests',
    perms: {
      createEvent: 'Create events and post notices',
      manageGates: 'Manage entry terminals',
      approveOverride: 'Approve entry exceptions',
      manageManagers: 'Manage managers',
      manageBudget: 'Manage costs',
    },
    invited: 'Invitation created. Send the link below to the person it is for',
    link: 'Invitation link',
    linkOnce: 'The link is only shown for an invitation you just created. Make a new one if you need it again',
    revoke: 'Withdraw invitation',
    invites: 'Invitations',
    invitesLoading: 'Loading the invitations',
    invitesEmpty: 'No invitations yet',
    invitesNotAllowed: 'Only the owner, or somebody who may manage managers, can see the invitations',
    createdAt: 'Created',
    expiresAt: 'Valid until',
    requiredSender: 'Must be sent from this account',
    status: {
      sent: 'Sent',
      accepted: 'Accepted',
      revoked: 'Withdrawn',
      expired: 'Expired',
    },
    grant: 'Give the role',
    grantClose: 'Close',
    grantHelp: 'Write the account address the invited person gave you. Only the organisation owner can send this last step',
    account: 'Account address',
    granted: 'The role is in place',
    working: 'Sending',
    check: 'Check now',
    notOwner: 'Only the organisation owner can give a role',
    problems: {
      orgId: 'Write the organisation number as a whole number of 1 or more',
      phone: 'Write the mobile number in international form, starting with +',
      account: 'Copy the account address as 42 characters starting with 0x',
      bits: 'Please pick at least one permission',
      notAllowed: 'You may not add people to this organisation',
      notOwner: 'Only the organisation owner can send this',
      unknownOrg: 'No organisation has that number',
      notFound: 'No such invitation',
      failed: 'Could not send that. Please try again in a moment',
    },
  },

  invite: {
    title: 'Accept an invitation',
    working: 'Checking the invitation',
    accepted: 'Invitation accepted',
    ownerMustSend: 'The organisation owner has to send the last step. Give them your account address below',
    owner: 'Owner address',
    yourAccount: 'Your account address',
    role: 'Role',
    orgId: 'Organisation number',
    check: 'Check now',
    done: 'The role is in place',
    waiting: 'This turns to done once the owner has sent it',
    problems: {
      notForYou: 'This invitation was sent to a different number',
      used: 'Somebody else has already accepted this invitation',
      expired: 'This invitation has expired',
      notFound: 'No such invitation',
      noPhone: 'Please finish verifying your mobile number first',
      failed: 'Could not check the invitation. Please try again in a moment',
    },
  },

  dashboard: {
    title: 'Event status',
    sold: 'Signed up',
    remaining: 'Left',
    checkins: 'Entered',
    attendees: 'Attendees',
    none: 'Nobody has signed up yet',
    kyc: 'Identity check',
    kycYes: 'Done',
    kycNo: 'Not done',
    checkedIn: 'In',
    notCheckedIn: 'Not yet',
    gates: 'Entry terminals',
    notIndexed: 'No event has that number, or it has not been indexed yet',
    failed: 'Could not load the status. Please try again in a moment',
  },

  announce: {
    title: 'Notice',
    placeholder: 'Notice (up to 500 characters)',
    post: 'Post the notice',
    posting: 'Posting',
    posted: 'Posted notices',
    loading: 'Loading the notices',
    none: 'No notices yet',
    loadFailed: 'Could not load the notices already posted. Only the ones you just posted are listed below',
    tooLong: 'Up to 500 characters',
    notAllowed: 'You may not post notices for this event',
    chatClosed: 'The event is over and the room is closed',
    failed: 'Could not post the notice. Please try again in a moment',
  },

  /** See the Korean block above: one scroll for the event, one for the tickets, then done. */
  scene: {
    title: 'Create an event',
    leave: 'Leave',
    resumed: 'Carrying on where you left off',
    startOver: 'Start over',
    next: 'Next',
    back: 'Back to the event',

    saveAuto: 'Saved as you write',
    saving: 'Saving…',
    saveFailed: 'Not saved · try again',
    savedNow: 'Saved · just now',
    savedAgo: 'Saved · {{ago}}',
    agoMinutes: '{{count}} min ago',
    agoHours: '{{count}} h ago',

    poster: 'Poster',
    posterEmpty: 'Your poster appears here',
    posterChange: 'Change the poster',
    posterWorking: 'Uploading the poster',
    posterAlt: 'Poster preview',

    titleLabel: 'Title',
    titlePlaceholder: 'What is the event?',
    themeLabel: 'Theme',
    theme0: 'Concert', theme1: 'Meetup', theme2: 'Exhibition', theme3: 'Other',
    tagsLabel: 'Tags',
    tagsHelp: 'Up to five, each up to 12 characters. Tap one to remove it',
    tagPlaceholder: 'e.g. jazz',
    tagAdd: 'Add a tag',
    tagRemove: 'Remove {{tag}}',
    bodyLabel: 'About this event',
    bodyPlaceholder: 'Tell people what the event is',
    count: '{{count}}/{{max}}',

    placeLabel: 'Where',
    regionLabel: 'Region',
    venuePlaceholder: 'Venue name or address',
    timeLabel: 'When',
    startsAt: 'Starts',
    endsAt: 'Ends',
    holdersOnly: 'Only people with a ticket',
    // Backend report 9.3: hidden can be opened up at any time, open can never be hidden again.
    venueHiddenHelp: 'Explore screens show the region only. People who got a ticket are told the exact place',
    venueHiddenOneWay: 'Create it open and it can never be hidden later. Hidden can be opened up at any time',
    timeHiddenHelp: 'Explore screens show the date only. People who got a ticket are told the start time',
    saleHelp: 'Sign-ups open the moment you create the event and close when it ends',

    problems: {
      poster: 'Please upload a poster',
      title: 'Write a title of 2 to 60 characters',
      tags: 'Up to five tags, each up to 12 characters',
      body: 'Write the description in 2000 characters or fewer',
      region: 'Please pick a region',
      venue: 'Please write the venue',
      venueTooLong: 'Write the venue in 200 characters or fewer',
      startsAt: 'Please pick a start time',
      endsAt: 'Please pick an end time',
      schedule: 'The end has to come after the start',
    },


    tiers: {
      title: 'Tickets',
      create: 'Create the event',
      add: 'Add a kind',
      remove: 'Remove',
      kind: 'Kind {{index}}',
      name: 'Name',
      namePlaceholder: 'e.g. General',
      supply: 'How many',
      maxPerWallet: 'Most one person may hold',
      price: 'Price',
      free: 'Free',
      amount: 'Amount',
      art: 'Ticket picture',
      artA: 'Aurora', artB: 'Ember', artC: 'Teal', artD: 'Dusk',
      artUpload: 'Upload your own',
      artUploadClose: 'Never mind',
      artWorking: 'Uploading the picture',
      // Blocked where the choice was made, not at the end (plan section B-3).
      paidBlocked: 'Paid tickets are coming soon. For now an event can only be free',
      rules: 'Rules for the whole event',
      // These three live on EventMeta and not on Tier, so a per-kind switch would be a lie.
      rulesHelp: 'These three cannot differ by kind. There is one of each per event',
      transferable: 'Can be handed over',
      cutoff: 'Hand-over closes (hours before the event starts)',
      requireKyc: 'Only people who passed the identity check',
      requireKycHelp: 'With this on, only people who finished the ID and face check can get a ticket. Leave it off for casual meetups',
      feeNote: 'MONTI covers the cost of creating it',
    },


    publish: {
      pinning: 'Uploading the event details',
      sending: 'Creating the event',
      finishing: 'Finishing up',
      // A timeout is not a failure. Sending it twice would be two events.
      confirming: 'Still being created. You can leave this screen — check your organiser screen in a moment',
    },

    publishProblems: {
      notYourOrg: 'You may not create events for this organiser',
      pinFailed: 'Cannot save that right now. Please try again in a moment',
      badMeta: 'The title or the description is too long. Please shorten it and try again',
      badTags: 'Please check the tags again',
      badPoster: 'Please upload the poster again',
      schedule: 'The end has to come after the start',
      tiersEmpty: 'Add at least one ticket kind',
      failed: 'Could not create the event. Please try again in a moment',
    },

    tierProblems: {
      eventIncomplete: 'Some of the event details are still missing',
      tiersTooMany: 'Up to eight kinds',
      tierName: 'Give every kind a name',
      tierSupply: 'Write how many as 1 or more',
      tierMaxPerWallet: 'Write the per-person limit as a number from 1 to 65535',
      cutoff: 'Write the hand-over cut-off as 0 hours or more',
      paidTier: 'One of the kinds is not free. Make it free and you can create the event',
    },

    imageProblems: {
      tooLarge: 'That photo is too big. Please choose another one',
      format: 'JPG and PNG photos only',
      dimensions: 'That photo is too big. Each side has to be 4000 pixels or fewer',
      quota: 'No more photos today. Please try again tomorrow',
      notActive: 'Please finish signing up first',
      failed: 'Could not upload the photo. Please try again in a moment',
    },
  },

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
    openEvent: 'Open the event screen',

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
      venueTooLong: 'Write the venue in 200 characters or fewer',
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
