export const registrationConfig = {
  academicYear: null,
  status: "preparing",
  registrationUrl: null,
  deadline: null,
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
