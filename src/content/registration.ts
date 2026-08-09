export const registrationConfig = {
  academicYear: null,
  status: "preparing",
  registrationUrl: null,
  deadline: null,
  schedules: [],
  prices: [],
};

export const registrationCopy = {
  heading: "Бүртгэлийн мэдээлэл",
  intro:
    "Шинэ бүртгэлийн системийг бэлтгэж байна. Одоогоор хуучин жилийн цагийн хуваарь, төлбөр, хугацааг энэ хуудсанд одоогийн мэдээлэл мэт нийтлээгүй.",
  actionLabel: "Бүртгүүлэх",
  actionHref: "/register",
  statusLabel: "Бүртгэл нээгдэхэд энд шинэ мэдээлэл байрлана.",
};

export const registrationPrototype = {
  title: "Бүртгэл",
  description:
    "Наран Эрдэм сургалтын бүртгэлийн шинэ урсгалын хөгжүүлэлтийн прототип.",
  notice:
    "Туршилтын хувилбар — энд бөглөсөн мэдээлэл хадгалагдахгүй, бүртгэл үүсэхгүй.",
  steps: [
    "Асран хамгаалагч",
    "Хүүхэд",
    "Анги, цаг",
    "Журам",
    "Төлбөр",
    "Хянах",
  ],
};

export const placementRules = {
  note: "Эдгээр нь хөгжүүлэлтийн жишээ дүрэм бөгөөд тухайн жилийн тохиргоогоор өөрчлөгдөнө.",
  newStudentRules: [
    { grades: ["4", "5", "6"], recommendedStage: "stage-1" },
    { grades: ["7"], recommendedStage: "stage-2" },
    { grades: ["8", "9", "10"], recommendedStage: "stage-3" },
  ],
};

export const classSessionConfig = {
  isDevelopmentSample: true,
  defaultCapacity: 10,
  sessions: [
    {
      id: "dev-stage-1-sat-morning",
      stageId: "stage-1",
      stageLabel: "1-р шат — Анхан шат",
      weekday: "Бямба",
      startTime: "10:00",
      endTime: "11:20",
      availability: "available",
      note: "Хөгжүүлэлтийн жишээ цаг",
    },
    {
      id: "dev-stage-1-sat-afternoon",
      stageId: "stage-1",
      stageLabel: "1-р шат — Анхан шат",
      weekday: "Бямба",
      startTime: "14:00",
      endTime: "15:20",
      availability: "full",
      note: "Дүүрсэн төлөвийн жишээ",
    },
    {
      id: "dev-stage-2-sun-morning",
      stageId: "stage-2",
      stageLabel: "2-р шат — Дунд түвшин",
      weekday: "Ням",
      startTime: "10:00",
      endTime: "11:20",
      availability: "available",
      note: "Хөгжүүлэлтийн жишээ цаг",
    },
    {
      id: "dev-stage-3-sun-afternoon",
      stageId: "stage-3",
      stageLabel: "3-р шат — Ахисан түвшин",
      weekday: "Ням",
      startTime: "13:00",
      endTime: "15:00",
      availability: "unavailable",
      note: "Одоогоор сонгох боломжгүй төлөвийн жишээ",
    },
  ],
};

export const feeConfig = {
  currentPricesConfigured: false,
  standardPaymentPlans: [
    {
      id: "full-year",
      label: "Бүтэн жилээр төлөх",
      summary: "Нэг удаа төлөх стандарт сонголт. Нийт дүн бага байна.",
    },
    {
      id: "two-part",
      label: "2 хувааж төлөх",
      summary: "Жилийн төлбөрийг хоёр хэсэгт хуваах стандарт сонголт.",
    },
  ],
  ancillaryCharges: [],
};

export const publicDiscountCopy = {
  family:
    "Нэг гэр бүлийн 2 ба түүнээс олон хүүхэд тухайн хичээлийн жилд баталгаажсан тохиолдолд хүүхэд бүрийн сургалтын төлбөрт 10% гэр бүлийн хөнгөлөлт тооцох дүрэмтэй.",
  referral:
    "Одоо суралцаж байгаа хүүхдийн урилгын кодоор бүртгүүлсэн бол урьсан болон уригдсан хүүхэд хоёул баталгаажсаны дараа тус бүр 5% урамшуулал авах боломжтой.",
  basis:
    "Хөнгөлөлт нь зөвхөн сургалтын төлбөрөөс тооцогдоно. Халаад зэрэг нэмэлт төлбөрт тооцохгүй.",
};

export const rulesContent = {
  parent: {
    title: "Эцэг эх, асран хамгаалагчийн журам",
    summary: [
      "Хөтөлбөрийн зорилго, хүрээг ойлгож, хичээлийн жилийн турш тогтмол хамрагдахад анхаарна.",
      "Төлбөр, хуваарь, амралтын өдрүүд, цагийн өөрчлөлтийн мэдээллийг цаг тухайд нь шалгана.",
      "Ангийн мэдээлэл, зарлал, харилцааг Facebook групп зэрэг албан сувгаар тогтмол хянана.",
    ],
    acknowledgement:
      "Би хүүхэдтэйгээ хамт бүртгэлийн мэдээлэл, журмыг уншиж танилцсан бөгөөд хүүхдээ бүртгүүлэхийг зөвшөөрч байна.",
  },
  student: {
    title: "Сурагчийн журам",
    summary: [
      "Хүүхэд хичээлд идэвхтэй, дуртай оролцож, багшийн зааврыг дагана.",
      "Туршилтын аюулгүй байдлыг мөрдөж, бусадтай хүндэтгэлтэй харилцана.",
      "Тэмдэглэл хөтөлж, багаар хийх туршилтад бусад хүүхдэд оролцох боломж олгоно.",
      "Цаг баримталж, хэрэглэсэн хэрэгсэл, материалыг цэвэрлэж буцаана.",
    ],
    acknowledgement:
      "Би энэ сургалтад өөрийн хүсэлтээр суралцахыг хүсэж, сурагчийн журамтай танилцлаа.",
  },
};
