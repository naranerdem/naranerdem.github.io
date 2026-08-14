/**
 * Source-controlled initialization templates for non-private operational data.
 *
 * These templates are imported explicitly; they never overwrite teacher-edited
 * or published D1 records. Annual curricula are logical, reusable Programs;
 * Offering dates determine the academic year in which they are used.
 *
 * Academic-year shape:
 * { key, label, startsOn, endsOn }
 *
 * Program shape:
 * { key, kind: 'annual_course' | 'summer_course', displayName, stageCode?,
 *   publish?, lessons: [{ title, internalNote? }] }
 *
 * School-period shape:
 * { key, academicYearKey, label, startsOn, endsOn,
 *   generationBehavior: 'exclude_by_default' | 'warn_only' }
 */
export const operationalDefaults = Object.freeze({
  version: 3,
  academicYears: Object.freeze([
    Object.freeze({
      key: "2026-27",
      label: "2026–2027 хичээлийн жил",
      startsOn: "2026-09-01",
      endsOn: "2027-06-01",
    }),
  ]),
  programs: Object.freeze([
    Object.freeze({
      key: "annual-stage-1", kind: "annual_course", displayName: "1-р шат", stageCode: "stage_1", publish: true,
      lessons: Object.freeze([
        "Соронзны шинж чанар", "Хүндийн төв ба тэнцвэр", "Атом молекул", "Бодисын гурван төлөв", "Дуу авиа", "Гэрэл ба толь", "Цахилгааны үндэс", "Дулаан ба тэлэлт агшилт", "Дулаан дамжуулал", "Даралт ба салхи", "Хүндийн жин", "Од", "Хөшүүрэг", "Статик цахилгаан", "Уусмал", "Сар", "Нар сүүдрийн хөдөлгөөн", "Цахилгаан хэлхээ", "Уурын хөдөлгүүр", "Уушги ба амьсгал", "Булчин ба яс", "Ус ба агаар", "Усан оргилуур", "Пүршний шинж чанар", "Салхиар хөдлөх механизм", "Үр ба нахиа", "Цардуул", "Фотосинтез", "Цэцэг ба жимс", "Бичил биетэн",
      ].map((title) => Object.freeze({ title }))),
    }),
    Object.freeze({
      key: "annual-stage-2", kind: "annual_course", displayName: "2-р шат", stageCode: "stage_2", publish: true,
      lessons: Object.freeze([
        "Хүчил・шүлт・саармаг", "Шатах үзэгдэл", "Дулаан ба илчлэг", "Хүч ба хөшүүрэг", "Дүүжин", "Эргэвч", "Хүчилтөрөгчийн шинж", "Нүүрсхүчлийн ба аммиакын хий", "Бодисуудын шатах шинж", "Дулаан ялгаруулах ба шингээх", "Нар сарны хиртэлт", "Одны планетариум", "Цахилгаан соронз", "Мотор", "Бодисын нягт", "Агаарын чийгшил", "Хөвөх хүч", "Өнгөний шинж чанар", "Холимог бодис", "Хоол боловсруулах", "Цус ба зүрх", "Газрын үе давхарга", "Чулуулаг", "Устөрөгчийн шинж", "Гэрэл ба линз", "Гүйдэл ба Омын хууль", "Цахилгаан үүсгэх", "Хурд хүчний хамаарал", "Ургамлын эрхтэн", "Калейдоскоп",
      ].map((title) => Object.freeze({ title }))),
    }),
    Object.freeze({
      key: "annual-stage-3", kind: "annual_course", displayName: "3-р шат", stageCode: "stage_3", publish: true,
      lessons: Object.freeze([
        "Цахилгаан ба соронзон чанар", "Цахилгаан соронзон долгион", "Мэдээлэл дамжуулах", "Адиабат үзэгдэл", "Долгионы үзэгдлүүд", "Электролиз ба химийн батарей", "Эс ба ДНХ", "Исэх хөөх үзэгдэл", "Цахилгаан хэлхээ", "Хагас дамжуулагч", "Усны шинж", "Урсах биеийн шинж", "Инерци", "Хурдатгал ба чөлөөт уналт", "Араат дамжуулагч", "Материал ба бодис", "Газар хөдлөлт", "Харьцангуйн тусгай онол", "Лед гэрэл", "Гэрэл ба квант механик", "Масс ба энерги", "Эгэл бөөм", "Оптик ба дуран",
      ].map((title) => Object.freeze({ title }))),
    }),
  ]),
  // БШУЯ-ны 2026-07-08-ны А/211 тушаал, Хавсралт 1-ийн Улаанбаатар
  // хотын VI–IX ангийн мөрийг Наран Эрдмийн хуваарийн удирдамж болгон
  // буулгав. Эдгээр нь анхны үүсгэх үеийн удирдамж бөгөөд багш тухайн
  // ангийн өдрийг сэргээж, хадгалсан хуанлиа цаашид өөрөө удирдана.
  schoolCalendarPeriods: Object.freeze([
    Object.freeze({ key: "2026-27-autumn-break", academicYearKey: "2026-27", label: "Намрын амралт", startsOn: "2026-10-31", endsOn: "2026-11-08", generationBehavior: "exclude_by_default" }),
    Object.freeze({ key: "2026-27-winter-break", academicYearKey: "2026-27", label: "Өвлийн завсарлага", startsOn: "2026-12-26", endsOn: "2027-01-17", generationBehavior: "exclude_by_default" }),
    Object.freeze({ key: "2026-27-tsagaan-sar-study", academicYearKey: "2026-27", label: "Цагаан сарын үеийн бие даалт", startsOn: "2027-02-08", endsOn: "2027-02-12", generationBehavior: "exclude_by_default" }),
    Object.freeze({ key: "2026-27-spring-break", academicYearKey: "2026-27", label: "Хаврын амралт", startsOn: "2027-03-20", endsOn: "2027-03-28", generationBehavior: "exclude_by_default" }),
    Object.freeze({ key: "2026-27-republic-day", academicYearKey: "2026-27", label: "Бүгд Найрамдах Улс тунхагласан өдөр", startsOn: "2026-11-26", endsOn: "2026-11-26", generationBehavior: "exclude_by_default" }),
    Object.freeze({ key: "2026-27-womens-day", academicYearKey: "2026-27", label: "Олон улсын эмэгтэйчүүдийн өдөр", startsOn: "2027-03-08", endsOn: "2027-03-08", generationBehavior: "exclude_by_default" }),
  ]),
});
