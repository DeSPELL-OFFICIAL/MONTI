import { useLocale } from '../shared/i18n';
import type { TicketArtPreset } from '../shared/ui';

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

    orgs: '우리 팀',
    org: '우리 팀',
    orgsEmpty: '아직 속한 팀이 없어요.',
    become: '팀 만들기',
    // 콜러블이 답한 번호가 인덱서에 오르기까지 1~2초가 걸린다. 그 사이에 여기로 오면 목록에 없다.
    orgPending: '방금 만든 팀은 잠시 뒤에 목록에 나타나요',
    noPermission: '행사를 만들 권한이 없어요. 팀 오너에게 권한을 요청해 주세요',

    events: '내 행사',
    eventsEmpty: '아직 만든 행사가 없어요. 아래 만들기로 시작해 보세요',
    eventsFailed: '내 행사를 가져오지 못했어요. 잠시 뒤 다시 시도해 주세요',
    // 목록은 체인 줄만 읽는다. 제목은 IPFS에 있고, 느린 게이트웨이가 목록을 붙잡으면 안 된다.
    eventFallback: '행사 #{{id}}',
    status: { Draft: '작성 중', Published: '공개됨', Cancelled: '취소됨' },

    create: '만들기',
    retry: '다시 시도',
    // 45s 하드캡에서 '나중에 확인'으로 나온 뒤, 홈에서 그 생성 op를 이어서 확인하는 배경 배너(계획 §2a).
    pendingCreate: '만들던 행사를 확인하고 있어요',
    pendingCreateFailed: '행사를 만들지 못했어요. 다시 시도해 주세요',
    pendingCreateOpen: '이어서 확인',

    manual: '행사 번호로 열기',
    eventId: '행사 번호',
    open: '열기',
    team: '팀',
    orgId: '조직 번호',
    // 체인에는 이름이 없다. orgProfiles 문서가 없는 조직은 번호로 부른다.
    orgFallback: '팀 #{{id}}',
  },

  become: {
    title: '팀 만들기',
    name: '팀 이름',
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
      limit: '팀은 3개까지 만들 수 있어요',
      badName: '이름을 2자에서 40자 사이로 적어 주세요',
    },
  },

  lifecycle: {
    publish: '공개하기',
    publishConfirm: '공개하면 누구나 이 행사를 보고 신청할 수 있어요. 공개한 뒤에는 내용을 고칠 수 없어요',
    cancel: '행사 취소하기',
    // 01b 재배포 뒤에는 취소된 행사의 티켓을 남에게 넘길 수 없다. 확인 창에서 미리 말해 둔다.
    cancelConfirm: '취소하면 되돌릴 수 없어요. 신청이 닫히고, 이미 나간 티켓은 다음 업데이트부터 남에게 넘길 수 없게 돼요',
    confirm: '네, 진행할게요',
    back: '아니요',
    working: '보내고 있어요',
    published: '공개했어요',
    cancelled: '취소했어요',
    confirming: '아직 확인 중이에요. 잠시 뒤 이 화면을 다시 열어 주세요',
    notDraft: '이미 공개한 행사예요',
    // updateEventMeta 가 낼 수 있는 나머지 두 되돌림(Ticket.sol:208). 발행·취소에서는 안 난다.
    schedule: '행사 시간이 이미 지났어요',
    tiers: '티켓 종류를 확인해 주세요',
    closed: '이미 끝났거나 취소된 행사예요',
    notAllowed: '이 행사를 다룰 권한이 없어요',
    failed: '보내지 못했어요. 잠시 뒤 다시 시도해 주세요',
    // 발행 전에 무엇을 공개하는지 한눈에 보여주는 요약 시트(계획 §2b).
    summary: {
      heading: '이대로 공개할까요?',
      title: '제목', date: '날짜', place: '장소', tiers: '티켓 종류', kyc: '본인 확인',
      tiersValue: '{{count}}종', kycOn: '필요', kycOff: '없음',
      placeRegionOnly: '{{region}} · 자세한 장소는 티켓 소지자에게만',
    },
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
    requests: '신청 관리',
    // 공개 전에만 열린다 — updateEventMeta 는 Draft 에서만 된다(Ticket.sol:235).
    edit: '행사 정보 고치기',
    notIndexed: '없는 행사 번호이거나 아직 색인 전이에요',
    failed: '현황을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요',

    /**
     * 창업자 요구 "이미지는 나중에 수정 가능". 티켓 그림만 공개 뒤에도 바꿀 수 있다 —
     * Tier 에 그림 칸이 없고(Ticket.sol:40-47) updateEventMeta 는 Draft 에서만 되므로
     * 그림은 체인이 아니라 eventArt/{eventId} 에 있다(계획 B-4).
     */
    art: {
      title: '티켓 이미지',
      help: '행사를 공개한 뒤에도 언제든 바꿀 수 있어요',
      kind: '{{index}}번째 종류',
      change: '바꾸기',
      close: '그만두기',
      // 읽기 실패는 '그림 없음'이 아니다 — saveEventArt 는 문서를 통째로 덮어쓰므로
      // 못 읽은 채로 저장하면 올려 둔 그림이 기본값으로 지워진다.
      loadFailed: '지금 티켓 그림을 불러올 수 없어요. 덮어쓰지 않도록 바꾸기를 잠가 뒀어요',
      retry: '다시 시도',
      saving: '저장하고 있어요',
      saved: '저장했어요',
      notAllowed: '이 행사의 티켓 그림을 바꿀 권한이 없어요',
      failed: '티켓 그림을 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요',
      untitled: '이름 없는 행사',
    },
  },

  requests: {
    title: '신청 관리',
    back: '행사 현황으로',
    empty: '기다리는 신청이 없어요',
    loadFailed: '신청 목록을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요',
    retry: '다시 시도',
    noPermission: '이 행사의 신청을 처리할 권한이 없어요',
    approveSelected: '선택 승인',
    approveAll: '전체 승인',
    reject: '거절',
    tier: '{{tier}}번째 종류',
    working: '처리하고 있어요',
    confirming: '아직 확인 중이에요. 잠시 뒤 새로고침하면 반영돼요',
    failed: '처리하지 못했어요. 잠시 뒤 다시 시도해 주세요',
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

  /** The creation scene: one scroll for the event, one for the tickets, and a done screen. */
  scene: {
    title: '행사 만들기',
    leave: '나가기',
    // 만들기 ≠ 발행. 생성 씬과 done 화면 상단의 2단계 헤더가 발행이 남았음을 처음부터 알린다(계획 §2b).
    stepCreate: '만들기',
    stepPublish: '공개',
    // 기본 다섯 칸(포스터·제목·시작·장소·티켓) 밖의 모든 것이 이 안에 접혀 있다(계획 B-2).
    more: '더 설정하기',

    /** 이미 만들어진 행사를 같은 씬에서 고친다(T-EV-W12). 공개 전에만 열린다. */
    edit: {
      title: '행사 정보 고치기',
      loading: '행사 정보를 불러오고 있어요',
      notDraft: '이미 공개한 행사는 고칠 수 없어요',
      back: '행사 화면으로',
    },

    saveAuto: '적는 대로 저장돼요',
    saving: '저장 중…',
    saveFailed: '저장 안 됨 · 다시 시도',
    savedAgo: '저장됨 · {{ago}}',
    agoNow: '방금',
    agoMinutes: '{{count}}분 전',
    agoHours: '{{count}}시간 전',
    // 자동저장은 처음부터 다 돌고 있었고 화면에 흔적이 없었다(계획 F-2). 이 버튼이 그 증거다.
    saveDraft: '임시 저장',
    saved: '저장됨',

    /** 초안을 두고 나갔던 사람이 다시 들어올 때 묻는 바텀 시트(계획 F-3). */
    resume: {
      title: '이어서 작성할까요?',
      body: '{{title}} · 마지막 저장 {{when}}',
      untitled: '제목 없는 행사',
      keep: '이어서 작성하기',
      // 옛 초안을 지우지 않는다 — 5개까지 남고 오래된 것부터 밀린다(계획 F-4).
      fresh: '새로 만들기',
    },

    poster: '포스터',
    posterEmpty: '포스터를 올리면 여기에 보여요',
    posterAdd: '포스터 올리기',
    posterChange: '포스터 바꾸기',
    posterWorking: '포스터를 올리고 있어요',
    posterRetry: '다시 올리기',
    // 업로드가 아직 돌고 있을 때 만들기를 누른 경우. 막지 않고 기다린다(계획 D-3).
    posterWaiting: '포스터를 올리는 중이에요. 곧 끝나요',
    posterAlt: '포스터 미리보기',

    titleLabel: '제목',
    titlePlaceholder: '무슨 행사인가요?',
    themeLabel: '테마',
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
    endsAtHelp: '비워 두면 시작 2시간 뒤로 잡아요',
    holdersOnly: '티켓 소지자에게만 공개',
    // 백엔드 T-EV-B 보고 9.3: 숨김 → 공개는 언제든 되지만 그 반대는 안 된다.
    venueHiddenHelp: '탐색 화면에는 지역만 보여요. 자세한 장소는 티켓을 받은 사람에게만 알려줘요',
    venueHiddenOneWay: '공개로 두고 만들면 나중에는 숨길 수 없어요. 숨겨 두었다가 공개로 바꾸는 건 언제든 돼요',
    timeHiddenHelp: '탐색 화면에는 날짜만 보여요. 시작 시각은 티켓을 받은 사람에게만 알려줘요',
    saleHelp: '신청은 행사를 만든 순간 열리고 행사가 끝날 때 닫혀요',

    // 주최사가 하나도 없을 때만 만들기 버튼 위에 뜨는 한 줄. 이름은 서버가 orgProfiles 에
    // 적고 고칠 방법이 없으므로(계획 B-4), 그렇게 말해 둔다.
    org: {
      label: '주최자 이름',
      help: '행사 화면에 이 이름이 보여요. 나중에 바꿀 수 없어요.',
      placeholder: '예: 몬티 크루',
    },

    problems: {
      title: '제목을 2자에서 60자 사이로 적어 주세요',
      tags: '태그는 5개까지, 하나에 12자까지예요',
      body: '소개를 2000자 안으로 적어 주세요',
      bodyTooShort: '소개를 10자 이상 적어 주세요',
      region: '지역을 골라 주세요',
      venue: '장소를 적어 주세요',
      venueTooLong: '장소는 200자 안으로 적어 주세요',
      startsAt: '시작 시각을 골라 주세요',
      endsAt: '종료 시각을 골라 주세요',
      schedule: '종료 시각이 시작 시각보다 뒤여야 해요',
      // 며칠 전에 써 둔 초안을 오늘 발행할 때. 신청 기간이 지금~종료라 거꾸로가 된다.
      eventPast: '종료 시각이 이미 지났어요. 앞으로의 시각으로 고쳐 주세요',
    },


    tiers: {
      title: '티켓',
      create: '행사 만들기',
      add: '종류 추가',
      remove: '빼기',
      kind: '{{index}}번째 종류',
      // 창업자가 "이름이 뭔지 모르겠다"고 한 그 칸이다. 무엇의 이름인지 라벨이 말한다(계획 E-5).
      name: '티켓 종류 (예: 일반, VIP)',
      nameHelp: '티켓에 찍히는 이름이에요',
      namePlaceholder: '일반',
      supply: '수량',
      maxPerWallet: '1인당 한도',
      price: '가격',
      free: '무료',
      amount: '금액',
      save: '저장',
      art: '티켓 그림',
      // The carousel's own name for a screen reader; the tiles inside carry the preset names.
      artCarousel: '티켓 그림 고르기',
      // One name per preset letter, as a record rather than as flat `artA`..`artD` keys: the
      // `satisfies` below is what makes a locale that forgets a letter fail the build, which is
      // what the flat keys were for before there were twelve of them (plan section E-1).
      // 'Mint' 는 관객 금지어(`mint`)에 걸린다 — 색 이름은 '청록'/'Teal' 로 둔다.
      artNames: {
        a: '오로라', b: '잉걸', c: '청록', d: '어스름', e: '네온', f: '색종이',
        g: '물결', h: '햇살', i: '안개', j: '줄무늬', k: '점묘', l: '회로',
      } satisfies Record<TicketArtPreset, string>,
      artUpload: '직접 올리기',
      artUploadClose: '그만두기',
      artWorking: '그림을 올리고 있어요',
      // 유료 종류를 고른 그 자리에서 막는다 — 마지막에 거절당하는 게 제일 나쁘다(계획 B-3).
      paidBlocked: '유료 티켓은 곧 열려요. 지금은 무료로만 만들 수 있어요',
      // 무료 | 유료 세그먼트: 통화 칩 4개와 접힘을 대체하고 카드 상단에 항상 노출된다(계획 A-1).
      paid: '유료',
      // (i) 툴팁 — 창업자가 요청한 정확한 문구(계획 A-3).
      limitTip: '예매하는 본인도 1명으로 포함돼요. 가족·동행 표를 함께 사게 하려면 2 이상, 1인 1매로 막으려면 1로 두세요.',
      // 무료일 때만 나오는 받는 방식 2분기(계획 A-2). approvalRequired 는 이벤트 단위라 첫 카드에만 그린다.
      receiveMethod: '받는 방식',
      receiveAuto: '선착순 자동 승인',
      receiveApproval: '관리자 승인 후 받을 수 있어요',
      // 승인제는 01c 재배포 전까지 컨트랙트가 거절한다 — VITE_APPROVAL_MODES 로 열기 전엔 비활성.
      approvalSoon: '곧 열려요',
      rules: '행사 전체 규칙',
      // transferable·transferCutoffSeconds·requireKyc 는 EventMeta 에 있고 Tier 에는 없다.
      // 종류 카드 안에 두면 화면이 거짓말을 한다.
      rulesHelp: '이 세 가지는 종류마다 다르게 둘 수 없어요. 행사 하나에 하나씩이에요',
      transferable: '친구에게 줄 수 있음',
      cutoff: '친구에게 주기 마감 (행사 시작 N시간 전)',
      requireKyc: '본인 확인한 사람만',
      requireKycHelp: '켜면 신분증·얼굴 확인을 마친 사람만 티켓을 받을 수 있어요. 가벼운 모임은 꺼두세요',
      // 빠른 시작: 첫 종류와 받는 방식을 한 번에 정하는 프리셋 3종. 한 번 눌러 시작하고,
      // 세부는 아래 카드에서 고친다(계획 A-1). 승인 프리셋은 받는 방식 칩과 같은 조건으로 잠긴다.
      quickStart: '빠른 시작',
      quickFree: '무료 선착순',
      quickApproval: '무료 관리자 승인',
      quickPaid: '유료 일반',
      // 미리보기 위에 올리는 투명 버튼의 이름 — 그림·종류·제목·가격을 미리보기에서 바로 고친다.
      editArt: '티켓 그림 바꾸기',
      editKind: '종류 이름 편집',
      editTitle: '행사 제목 편집',
      editPrice: '가격 설정',
      feeNote: '만드는 비용은 MONTI가 대신 내요',
    },



    done: {
      title: '행사를 만들었어요',
      // 발행 전에는 공유 링크·QR을 숨기고, 이 사실을 그대로 말한다(T-SIMP-6). 공개는 이 화면에서 바로 한다.
      notYetPublic: '아직 아무에게도 안 보여요',
      // 이 화면의 1차 버튼: 다른 화면으로 보내지 않고 여기서 바로 공개한다(T-SIMP-6).
      publishNow: '지금 공개하기',
      // 공개에 성공한 뒤, 그 자리서 나타나는 공유 링크·QR 카드 위에 놓는 안내(T-SIMP-6).
      nowPublic: '공개했어요 · 이제 아래 링크로 초대할 수 있어요',
      manage: '행사 화면 열기',
      link: '행사 주소',
      copy: '주소 복사',
      copied: '복사했어요',
      copyFailed: '복사하지 못했어요. 주소를 길게 눌러 복사해 주세요',
      qr: '행사 주소 QR 코드',
      view: '행사 보기',
      home: '주최자 홈',
      // 재시도는 이 화면 안에 있다. 없는 화면으로 보내지 않는다.
      artFailed: '티켓 그림이나 장소를 저장하지 못했어요. 아래 다시 저장을 눌러 주세요. 저장할 때까지 초안을 지우지 않았어요',
      retry: '다시 저장',
      retryWorking: '저장하고 있어요',
      retryDone: '저장했어요',
      untitled: '이름 없는 행사',
    },

    publish: {
      pinning: '행사 정보를 올리고 있어요',
      org: '팀을 만들고 있어요',
      sending: '행사를 만들고 있어요',
      finishing: '마무리하고 있어요',
      updating: '행사 정보를 저장하고 있어요',
      // 45s 하드캡에 걸렸을 때 결정 블록의 문구와 버튼(계획 §2a·§3). 시간 초과는 실패가 아니고,
      // 다시 시도는 op 해시를 재확인하므로 두 번 눌러도 행사는 하나다.
      stuck: '아직 확인 중이에요. 다시 시도하거나 나중에 주최자 화면에서 확인할 수 있어요',
      checkLater: '나중에 확인',
    },

    publishProblems: {
      notYourOrg: '이 팀에서 행사를 만들 권한이 없어요',
      orgName: '주최자 이름을 2자에서 40자 사이로 적어 주세요',
      orgLimit: '팀은 3개까지 만들 수 있어요. 기존 팀으로 만들어 주세요',
      orgNotActive: '가입을 먼저 마무리해 주세요',
      orgFailed: '주최자 정보를 만들지 못했어요. 잠시 뒤 다시 시도해 주세요',
      // 행사는 만들어졌는데 영수증에서 번호를 못 읽은 경우. 초안과 오퍼레이션 해시를 남겨 두고,
      // 버튼을 다시 누르면 그 해시로 번호를 찾아온다 — 새 행사를 만들지 않는다.
      noEventId: '행사는 만들어졌어요. 번호만 아직 못 읽었으니 아래 \'행사 만들기\'를 한 번 더 눌러 번호를 찾아 주세요. 행사가 두 개로 만들어지지는 않아요',
      // 기록해 둔 옵이 문턱 미달이거나 너무 오래돼(만료) 새 수수료로 다시 보낼 때 뜨는 진행 안내. 고칠 문제가 아니다.
      opExpired: '이전 요청이 만료되어 다시 보내요',
      pinFailed: '지금은 저장할 수 없어요. 잠시 뒤 다시 시도해 주세요',
      badMeta: '제목이나 소개가 너무 길어요. 줄이고 다시 시도해 주세요',
      badTags: '태그를 다시 확인해 주세요',
      badPoster: '포스터를 다시 올려 주세요',
      notDraft: '이미 공개한 행사는 고칠 수 없어요',
      // 초안인 채로 종료 시각이 지나면 신청 기간(지금~종료)이 거꾸로가 되어 InvalidSchedule 이 난다.
      eventPast: '행사 시간이 이미 지났어요. 종료 시각을 고치고 다시 저장해 주세요',
      tiersInvalid: '티켓 종류를 확인해 주세요',
      followUpFailed: '티켓 그림이나 장소를 저장하지 못했어요. 저장을 한 번 더 눌러 주세요',
      schedule: '종료 시각이 시작 시각보다 뒤여야 해요',
      tiersEmpty: '티켓 종류를 하나 이상 만들어 주세요',
      failed: '행사를 만들지 못했어요. 잠시 뒤 다시 시도해 주세요',
    },

    tierProblems: {
      tiersTooMany: '종류는 8개까지예요',
      tierName: '모든 종류에 이름을 적어 주세요',
      tierNameTooLong: '종류 이름은 40자 안으로 적어 주세요',
      tierSupply: '수량을 1장 이상으로 적어 주세요',
      tierMaxPerWallet: '1인당 한도를 1장에서 65535장 사이로 적어 주세요',
      cutoff: '친구에게 주기 마감 시간을 0시간 이상으로 적어 주세요',
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

  /**
   * 페이마스터가 주최자 셀렉터를 아직 허용하지 않을 때만 뜬다. 운영자에게만 보이는 안내라
   * '지갑'을 쓸 수 있는 유일한 문구이고(`copy.test.ts` 가 이 한 문장만 허용한다),
   * 01b 재배포로 허용 목록이 채워지면 영영 뜨지 않는다.
   */
  unsponsored: {
    notice: '주최자 작업은 지금은 수수료 지갑이 필요해요',
    help: '다음 업데이트가 끝나면 MONTI가 대신 내드려요. 그때까지는 담당자에게 문의해 주세요',
  },
};

const en: typeof ko = {
  home: {
    title: 'Organiser',
    backToDiscover: 'Back to explore',

    orgs: 'Our team',
    org: 'Our team',
    orgsEmpty: 'You are not part of a team yet.',
    become: 'Create a team',
    // The callable answers with the number a second or two before the indexer lists it.
    orgPending: 'A team you just created appears in this list in a moment',
    noPermission: 'You may not create events. Ask the team owner to give you the permission',

    events: 'My events',
    eventsEmpty: 'No events yet. Start one with Create below',
    eventsFailed: 'Could not load your events. Please try again in a moment',
    // The list reads the indexed rows only. Titles live on IPFS, and a slow gateway must not
    // hold up rows that are already in hand.
    eventFallback: 'Event #{{id}}',
    status: { Draft: 'In progress', Published: 'Public', Cancelled: 'Cancelled' },

    create: 'Create',
    retry: 'Try again',
    // See the Korean block: the background banner that resolves a create left mid-confirm.
    pendingCreate: 'Checking on the event you were making',
    pendingCreateFailed: 'Could not create the event. Please try again',
    pendingCreateOpen: 'Check it',

    manual: 'Open by event number',
    eventId: 'Event number',
    open: 'Open',
    team: 'Team',
    orgId: 'Organisation number',
    // The chain holds no name. An organisation with no orgProfiles document goes by number.
    orgFallback: 'Team #{{id}}',
  },

  become: {
    title: 'Create a team',
    name: 'Team name',
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
      limit: 'You can create up to three teams',
      badName: 'Write a name of 2 to 40 characters',
    },
  },

  lifecycle: {
    publish: 'Make public',
    publishConfirm: 'Once it is public, anyone can see this event and sign up. You cannot change the details afterwards',
    cancel: 'Cancel this event',
    // After the 01b redeploy a cancelled event's tickets can no longer be handed over.
    cancelConfirm: 'Cancelling cannot be undone. Sign-ups close, and from the next update on nobody can hand an issued ticket to somebody else',
    confirm: 'Yes, go ahead',
    back: 'No',
    working: 'Sending',
    published: 'Made public',
    cancelled: 'Cancelled',
    confirming: 'Still confirming. Please open this screen again in a moment',
    notDraft: 'This event is already public',
    /** The other two `updateEventMeta` can revert with; publish and cancel never raise them. */
    schedule: 'This event\'s time has already passed',
    tiers: 'Please check the ticket kinds',
    closed: 'This event is already over or cancelled',
    notAllowed: 'You may not manage this event',
    failed: 'Could not send that. Please try again in a moment',
    // See the Korean block: the summary sheet shown before publishing.
    summary: {
      heading: 'Make it public as it is?',
      title: 'Title', date: 'When', place: 'Where', tiers: 'Ticket kinds', kyc: 'Identity check',
      tiersValue: '{{count}}', kycOn: 'Required', kycOff: 'Not needed',
      placeRegionOnly: '{{region}} · exact place shown to ticket holders only',
    },
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
    requests: 'Requests',
    /** Only before publishing: the chain refuses `updateEventMeta` past Draft. */
    edit: 'Edit this event',
    notIndexed: 'No event has that number, or it has not been indexed yet',
    failed: 'Could not load the status. Please try again in a moment',

    /** See the Korean block: the picture is the one part of a ticket editable after publishing. */
    art: {
      title: 'Ticket pictures',
      help: 'You can change these at any time, even after the event is public',
      kind: 'Kind {{index}}',
      change: 'Change',
      close: 'Done',
      // A failed read is not "no picture": saving on top of one would erase uploaded art.
      loadFailed: 'Could not load the ticket pictures right now. Changing them is locked so nothing is overwritten',
      retry: 'Try again',
      saving: 'Saving',
      saved: 'Saved',
      notAllowed: 'You may not change the pictures for this event',
      failed: 'Could not save the picture. Please try again in a moment',
      untitled: 'Unnamed event',
    },
  },

  requests: {
    title: 'Requests',
    back: 'Back to event status',
    empty: 'No requests are waiting',
    loadFailed: 'Could not load the requests. Please try again in a moment',
    retry: 'Try again',
    noPermission: 'You may not handle requests for this event',
    approveSelected: 'Approve selected',
    approveAll: 'Approve all',
    reject: 'Reject',
    tier: 'Kind {{tier}}',
    working: 'Working',
    confirming: 'Still confirming. Refresh in a moment to see the change',
    failed: 'Could not finish. Please try again in a moment',
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
    // See the Korean block: the two-step header that says publishing is still to come.
    stepCreate: 'Create',
    stepPublish: 'Publish',
    // See the Korean block: everything but the five fields that make an event is folded here.
    more: 'More settings',

    /** See the Korean block: the same scene, opened on an event that already exists. */
    edit: {
      title: 'Edit this event',
      loading: 'Loading the event',
      notDraft: 'An event that is already public cannot be edited',
      back: 'Back to the event',
    },

    saveAuto: 'Saved as you write',
    saving: 'Saving…',
    saveFailed: 'Not saved · try again',
    savedAgo: 'Saved · {{ago}}',
    agoNow: 'just now',
    agoMinutes: '{{count}} min ago',
    agoHours: '{{count}} h ago',
    // See the Korean block: the autosave was already doing all of this and none of it showed.
    saveDraft: 'Save draft',
    saved: 'Saved',

    /** See the Korean block: what a draft left behind asks on the way back in. */
    resume: {
      title: 'Carry on where you left off?',
      body: '{{title}} · last saved {{when}}',
      untitled: 'Untitled event',
      keep: 'Carry on',
      // See the Korean block: this keeps the old draft rather than throwing it away.
      fresh: 'Start a new one',
    },

    poster: 'Poster',
    posterEmpty: 'Your poster appears here',
    posterAdd: 'Add a poster',
    posterChange: 'Change the poster',
    posterWorking: 'Uploading the poster',
    posterRetry: 'Try again',
    // See the Korean block: 만들기 pressed while the upload is still going waits for it.
    posterWaiting: 'The poster is still going up. Nearly there',
    posterAlt: 'Poster preview',

    titleLabel: 'Title',
    titlePlaceholder: 'What is the event?',
    themeLabel: 'Theme',
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
    endsAtHelp: 'Left alone, it ends two hours after it starts',
    holdersOnly: 'Only people with a ticket',
    // Backend report 9.3: hidden can be opened up at any time, open can never be hidden again.
    venueHiddenHelp: 'Explore screens show the region only. People who got a ticket are told the exact place',
    venueHiddenOneWay: 'Create it open and it can never be hidden later. Hidden can be opened up at any time',
    timeHiddenHelp: 'Explore screens show the date only. People who got a ticket are told the start time',
    saleHelp: 'Sign-ups open the moment you create the event and close when it ends',

    // See the Korean block: one line above the button, and only for somebody with no
    // organiser yet. The server writes the name and nothing can change it afterwards.
    org: {
      label: 'Organiser name',
      help: 'This name appears on the event. It cannot be changed later.',
      placeholder: 'e.g. Monti Crew',
    },

    problems: {
      title: 'Write a title of 2 to 60 characters',
      tags: 'Up to five tags, each up to 12 characters',
      body: 'Write the description in 2000 characters or fewer',
      bodyTooShort: 'Write a description of at least 10 characters',
      region: 'Please pick a region',
      venue: 'Please write the venue',
      venueTooLong: 'Write the venue in 200 characters or fewer',
      startsAt: 'Please pick a start time',
      endsAt: 'Please pick an end time',
      schedule: 'The end has to come after the start',
      eventPast: 'The end time has already passed. Please pick a time in the future',
    },


    tiers: {
      title: 'Tickets',
      create: 'Create the event',
      add: 'Add a kind',
      remove: 'Remove',
      kind: 'Kind {{index}}',
      // The box the founder could not name. The label says what it is the name of.
      name: 'Ticket kind (e.g. General, VIP)',
      nameHelp: 'This is the name printed on the ticket',
      namePlaceholder: 'General',
      supply: 'How many',
      maxPerWallet: 'Most one person may hold',
      price: 'Price',
      free: 'Free',
      amount: 'Amount',
      save: 'Save',
      art: 'Ticket picture',
      // The carousel's own name for a screen reader; the tiles inside carry the preset names.
      artCarousel: 'Choose the ticket picture',
      artNames: {
        a: 'Aurora', b: 'Ember', c: 'Teal', d: 'Dusk', e: 'Neon', f: 'Confetti',
        g: 'Wave', h: 'Sunburst', i: 'Haze', j: 'Stripes', k: 'Dots', l: 'Circuit',
      } satisfies Record<TicketArtPreset, string>,
      artUpload: 'Upload your own',
      artUploadClose: 'Never mind',
      artWorking: 'Uploading the picture',
      // Blocked where the choice was made, not at the end (plan section B-3).
      paidBlocked: 'Paid tickets are coming soon. For now an event can only be free',
      // The 무료 | 유료 segment, always at the top of the card, replacing the fold and the four
      // currency chips (plan section A-1).
      paid: 'Paid',
      // The (i) tooltip in the exact words the founder asked for (plan section A-3).
      limitTip: 'You are counted as one of the buyers. Set it to 2 or more to let one person buy for family or a guest, or leave it at 1 to hold everyone to a single ticket.',
      // The two receiving methods, shown only while the event is free (plan section A-2).
      receiveMethod: 'How people receive it',
      receiveAuto: 'First come, issued automatically',
      receiveApproval: 'You get it after the organiser approves',
      // Approval is refused by the deployed contract until the 01c redeploy, so it is off until
      // VITE_APPROVAL_MODES opens it.
      approvalSoon: 'Coming soon',
      rules: 'Rules for the whole event',
      // These three live on EventMeta and not on Tier, so a per-kind switch would be a lie.
      rulesHelp: 'These three cannot differ by kind. There is one of each per event',
      transferable: 'Can be given to a friend',
      cutoff: 'Giving closes (hours before the event starts)',
      requireKyc: 'Only people who passed the identity check',
      requireKycHelp: 'With this on, only people who finished the ID and face check can get a ticket. Leave it off for casual meetups',
      // Quick start: three presets that set the first kind and the receiving method in one tap.
      // Start here, then fine-tune in the cards below (plan section A-1). The approval preset is
      // held behind the same flag as the receiving-method chip.
      quickStart: 'Quick start',
      quickFree: 'Free, first come',
      quickApproval: 'Free, organiser approves',
      quickPaid: 'Paid',
      // Names for the transparent buttons laid over the preview — edit the picture, the kind, the
      // title and the price straight from the preview.
      editArt: 'Change the ticket picture',
      editKind: 'Edit the kind name',
      editTitle: 'Edit the event title',
      editPrice: 'Set the price',
      feeNote: 'MONTI covers the cost of creating it',
    },



    done: {
      title: 'Your event is made',
      // See the Korean block: before publishing the share link and QR are hidden; publishing runs here.
      notYetPublic: 'Nobody can see it yet',
      // See the Korean block: the primary button that publishes the event right on this screen.
      publishNow: 'Make it public',
      // See the Korean block: shown above the share link and QR once the event is public.
      nowPublic: "It's public now · share the link below to invite people",
      manage: 'Open the event screen',
      link: 'Event address',
      copy: 'Copy the address',
      copied: 'Copied',
      copyFailed: 'Could not copy it. Press and hold the address to copy it',
      qr: 'QR code for the event address',
      view: 'See the event',
      home: 'Organiser home',
      // The retry lives on this screen. Nobody is sent to a screen that does not exist.
      artFailed: 'The ticket pictures or the venue did not save. Press Save again below. Your draft has been kept until they do',
      retry: 'Save again',
      retryWorking: 'Saving',
      retryDone: 'Saved',
      untitled: 'Unnamed event',
    },

    publish: {
      pinning: 'Uploading the event details',
      org: 'Creating your team',
      sending: 'Creating the event',
      finishing: 'Finishing up',
      updating: 'Saving the event',
      // See the Korean block: the decision block's line and buttons at the 45s cap. A timeout is not
      // a failure, and 다시 시도 re-checks the op hash, so pressing twice still makes one event.
      stuck: 'Still confirming. Try again, or check it later on your organiser screen',
      checkLater: 'Check later',
    },

    publishProblems: {
      notYourOrg: 'You may not create events for this team',
      orgName: 'Write an organiser name of 2 to 40 characters',
      orgLimit: 'You can have up to three teams. Please use one you already have',
      orgNotActive: 'Please finish signing up first',
      orgFailed: 'Could not create your organiser. Please try again in a moment',
      // The event was made but the receipt did not name it. The draft and the operation hash
      // are kept, and pressing again looks the number up by that hash — it makes no new event.
      noEventId: 'Your event was created. Only its number has not come back yet — press "Create the event" once more to look it up. It will not create a second event',
      // Shown while a recorded op that was underpriced or too old is being resent at the current
      // fee — progress, not a problem the organiser has to fix.
      opExpired: 'The earlier request expired — sending again',
      pinFailed: 'Cannot save that right now. Please try again in a moment',
      badMeta: 'The title or the description is too long. Please shorten it and try again',
      badTags: 'Please check the tags again',
      badPoster: 'Please upload the poster again',
      notDraft: 'An event that is already public cannot be edited',
      /** A Draft left past its end date makes the derived sign-up window run backwards. */
      eventPast: 'This event\'s time has already passed. Please fix the end time and save again',
      tiersInvalid: 'Please check the ticket kinds',
      followUpFailed: 'Could not save the ticket picture or the venue. Please press Save once more',
      schedule: 'The end has to come after the start',
      tiersEmpty: 'Add at least one ticket kind',
      failed: 'Could not create the event. Please try again in a moment',
    },

    tierProblems: {
      tiersTooMany: 'Up to eight kinds',
      tierName: 'Give every kind a name',
      tierNameTooLong: 'Write a kind name of 40 characters or fewer',
      tierSupply: 'Write how many as 1 or more',
      tierMaxPerWallet: 'Write the per-person limit as a number from 1 to 65535',
      cutoff: 'Write the giving cut-off as 0 hours or more',
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

  /** See the Korean block: the one notice allowed that vocabulary, and only to an organiser. */
  unsponsored: {
    notice: 'Organiser actions need a fee wallet for now',
    help: 'MONTI will cover them once the next update lands. Until then, please ask your contact',
  },
};

export type OrganizerCopy = typeof ko;
export const organizerCopy = { ko, en };

/** Typed organiser copy for the current locale. Re-renders when the language changes. */
export function useOrganizerCopy(): OrganizerCopy {
  return useLocale() === 'en' ? en : ko;
}
