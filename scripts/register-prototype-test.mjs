import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registrationEnvironmentPresentation } from "../public/scripts/registration-environment.js";

const page = readFileSync("src/pages/register.astro", "utf8");
const content = readFileSync("src/content/registration.ts", "utf8");

assert.match(page, /initialStageSelection\(window\.location\.search\)/);
assert.match(page, /userStageSelection\(stage\.value\)/);
assert.match(page, /applyStageRecommendation/);
assert.match(page, /data-child-stage/);
assert.match(page, /card\.dataset\.childCard = ""/);
assert.match(page, /data-child-class/);
assert.match(page, /data-child-waitlist/);
assert.match(page, /data-child-payment-plan/);
assert.match(page, /\[data-child-payment-plan\]:checked, input\[type="hidden"\]\[data-child-payment-plan\]/);
assert.match(page, /renderPaymentChoices/);
assert.match(page, /target\.querySelectorAll\("\[data-child-waitlist\]"\)/);
assert.match(page, /if \(other !== input\) other\.checked = false/);
assert.match(page, /type="radio" name="child-\$\{card\.dataset\.childIndex\}-class"/);
assert.doesNotMatch(page, /data-child-class required/);
assert.match(page, /const firstSurname = childCards\(\)\[0\]\?\.querySelector\("\[data-child-surname\]"\)\?\.value \|\| ""/);
assert.match(page, /data-child-surname value="\$\{escapeText\(surname\)\}"/);
assert.doesNotMatch(page, /data-child-surname[^\n]*(readonly|disabled)/);
assert.match(page, /data-previous-stage-field hidden/);
assert.match(page, /previous\.disabled = !visible/);
assert.match(page, /previous\.required = visible/);
assert.match(page, /field\.hidden = !visible/);
assert.match(page, /id="guardian-rules-dialog"/);
assert.match(page, /id="student-rules-dialog"/);
assert.match(page, /if \(parentAcknowledged && studentAcknowledged\) showReview\(\)/);
assert.match(page, /fetch\("\/api\/registration\/catalog"/);
assert.match(page, /fetch\("\/api\/registration\/bootstrap"/);
assert.match(page, /\.filter\(\(session\) => session\.stageCode === stage\)/, "class choices are filtered from the authoritative catalog by the selected stage code");
assert.match(page, /stage\.addEventListener\("change",[\s\S]*?delete card\.dataset\.selectedClassId;/, "changing stage clears a previously selected incompatible class");
assert.match(page, /selectedClassSessionId: card\.querySelector\("\[data-child-class\]:checked"\)\?\.value \|\| undefined/, "the submission payload uses the selected authoritative class-session radio value");
assert.match(page, /registrationEnvironmentPresentation/);
assert.match(page, /document\.getElementById\("review-help"\)\.textContent = presentation\.showStagingNotice/, "bootstrap uses the resolved environment presentation instead of an obsolete staging variable");
assert.match(page, /authEmailEnabled: false/, "static registration fallback keeps optional parent verification unavailable until authoritative bootstrap loads");
assert.match(page, /runtimeConfig\.authEmailEnabled \? `<p>И-мэйлээ баталгаажуулснаар/, "optional verification copy is gated by the authoritative auth-email capability");
assert.doesNotMatch(page, /И-мэйлээ баталгаажуулбал бүртгэлийн мэдээлэл, төлөвийн мэдэгдлийг и-мэйлээр авах боломжтой/, "registration payment screen never claims verification is required for ordinary notifications");
assert.doesNotMatch(page, /review-help"\)\.textContent = staging\b/, "an obsolete staging variable cannot abort the registration bootstrap and discard a valid catalog");
assert.match(page, /id="registration-environment-notice" class="prototype-notice" hidden/);
assert.doesNotMatch(page, /Туршилтын орчин — энд зөвхөн тест бүртгэл үүснэ/);
assert.doesNotMatch(content, /Туршилтын орчин — энд зөвхөн тест бүртгэл үүснэ/);
assert.match(page, /data-registration-surface="booting"/);
assert.match(page, /id="registration-booting"/);
assert.match(page, /id="registration-form" class="registration-form" novalidate hidden/);
assert.match(page, /async function settleInitialSurface\(\)/);
assert.match(page, /await loadBootstrap\(\)/);
assert.match(page, /showRegistrationForm\(\)/);
assert.match(page, /document\.body\.dataset\.registrationSurface = "verified"/);
assert.match(page, /await showVerifiedStatus\(status === "already-verified"\);\n          return;/);
assert.match(page, /fetch\("\/api\/registration\/submit"/);
assert.match(page, /fetch\("\/api\/registration\/status"/);
assert.doesNotMatch(page, /fetch\("\/api\/registration\/pending"/);
assert.match(page, /id="start-new-registration"/);
assert.match(page, /function startNewRegistration\(\)/);
assert.match(page, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
assert.match(page, /if \(!runtimeConfig\.writeEnabled\)/);
assert.match(page, /runtimeConfig\.stagingNotice/);
assert.match(page, /formCopy\.messages\.alreadyVerifiedTitle/);
assert.match(page, /classSelectionIssue/);
assert.match(page, /issue\.focusTarget === "class-status"|card\.querySelector\("\[data-catalog-message\]"\)/);
assert.doesNotMatch(page, /incomplete\.querySelector\("\[data-child-stage\]"\)/);
assert.doesNotMatch(page, /ranked_class_preference|preferenceLabels|1-р сонголт|2-р сонголт|3-р сонголт|wizard-step/);
assert.doesNotMatch(page, /feeConfig|name="paymentPlan"/);
assert.doesNotMatch(page, /second enrollment|өөр шат нэмэх|хоёр дахь шат/i);
assert.doesNotMatch(page, /fetch\([^\n]*\/api\/pre-registrations|method:\s*["']POST["'][^\n]*pre-registration/);
assert.doesNotMatch(content, /\* тэмдэгтэй талбарыг бөглөнө үү\./);
assert.match(content, /Өмнө нь Наран Эрдэмд сурсан уу\?/);
assert.match(content, /code: "Урилгын код"/);
assert.match(content, /Энэ шатны анги, цаг хараахан ороогүй байна\./);
assert.match(content, /Анги, суудлын мэдээлэл одоогоор түр боломжгүй байна\./, "catalog-fetch failure and a legitimately empty selected stage keep distinct public messages");
assert.match(content, /Төлбөр баталгаажихыг хүлээж буй: \{count\}/);
assert.match(content, /Энэ анги дүүрсэн тул та хүлээлгийн жагсаалтад орно\./);
assert.match(content, /Одоо төлбөр төлөхгүй бөгөөд суудал хадгалагдахгүй\./);
assert.match(content, /Одоогийн сонгосон анги хэвээр үргэлжилнэ\./);
assert.match(content, /Саналыг зөвшөөрсний дараа төлбөрийн хэлбэрээ сонгож, төлбөр хийх хугацаа эхэлнэ\./);
assert.match(page, /formCopy\.review\.waitlistExplanation/);
assert.match(page, /formCopy\.messages\.waitlistStatus/);
assert.match(page, /formCopy\.messages\.backupWaitlistStatus/);
assert.match(page, /REGISTRATION_DRAFT_KEY/);
assert.match(page, /createRegistrationDraft/);
assert.match(page, /readRegistrationDraft/);
const verificationPage = readFileSync("src/pages/verify-email.astro", "utf8");
assert.match(verificationPage, /window\.location\.hash/);
assert.match(verificationPage, /method: "POST"/);
assert.match(verificationPage, /window\.history\.replaceState/);
assert.match(verificationPage, /class="verification-card"/);
assert.match(verificationPage, /invalidResendHint/);
assert.doesNotMatch(verificationPage, /class="review-panel"/);
assert.doesNotMatch(content, /дараа нь өөрчил|өөрчилж болно|Авсан урилгын код|Нэг асран хамгаалагч хэд хэдэн хүүхэд|Өмнө сурч байсан бол сонгоно уу/);

assert.deepEqual(registrationEnvironmentPresentation({ environment: "production", writeEnabled: true }), {
  showStagingNotice: false,
  showProductionClosed: false,
});
assert.deepEqual(registrationEnvironmentPresentation({ environment: "production", writeEnabled: false }), {
  showStagingNotice: false,
  showProductionClosed: true,
});
assert.deepEqual(registrationEnvironmentPresentation({ environment: "staging", writeEnabled: true }), {
  showStagingNotice: true,
  showProductionClosed: false,
});

const builtPage = readFileSync("dist/register/index.html", "utf8");
assert.doesNotMatch(builtPage, /Туршилтын орчин — энд зөвхөн тест бүртгэл үүснэ/);
assert.doesNotMatch(builtPage, /Туршилтын хувилбар/);
assert.doesNotMatch(builtPage, /Туршилтаар дуусгах/);

console.log("ok registration prototype structure tests");
