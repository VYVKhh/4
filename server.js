/*
 * 4.js — خادم موقع مؤسسة ملتقى العلم والثقافية (نسخة معاد هيكلتها وموحّدة في ملف واحد)
 * ==========================================================================
 * لا يحتاج إلى npm install: يعتمد فقط على Node.js القياسي (http, fs, path, crypto).
 *
 * الإصلاحات الرئيسية في هذه النسخة مقارنة بالنسخة السابقة:
 *  1) لم تكن هناك واجهة أمامية (public/) على الإطلاق — الخادم كان "عقلًا بلا جسد":
 *     API يعمل لكن لا توجد صفحة رئيسية ولا لوحة إدارة تستدعيه. هذا هو سبب:
 *       - عدم ظهور الموقع بشكل صحيح عند فتح الرابط (404 دائمًا على "/").
 *       - عدم وجود أي خيارات لإضافة الصور/الفيديوهات/روابط التواصل، لأن لوحة
 *         الإدارة التي توفر هذه الخيارات لم تكن موجودة أصلًا.
 *     ← الحل: هذا الملف يُنشئ تلقائيًا مجلد public/ الكامل (الموقع + لوحة
 *       الإدارة) عند أول تشغيل، ويعيد كتابته في كل تشغيل ليبقى متزامنًا مع الكود.
 *
 *  2) رابط الصور المرفوعة كان معطوبًا فعليًا: الرفع يحفظ الملفات داخل
 *     data/uploads لكن تقديم الملفات الساكنة (serveStatic) كان يبحث فقط
 *     داخل public/، فلا يجد الصورة أبدًا ويُعيد 404 بصمت.
 *     ← الحل: أضفنا مسارًا مخصصًا لخدمة /uploads/* من data/uploads مباشرة.
 *
 *  3) الجلسات (تسجيل الدخول) كانت تُحفظ في الذاكرة فقط (Map). أي استضافة
 *     تعيد تشغيل العملية بين الطلبات (شائع في الاستضافات المشتركة/CGI) تفقد
 *     كل الجلسات فورًا، فيبدو الأمر وكأن «الدخول يعمل مرة واحدة فقط».
 *     ← الحل: الجلسات الآن تُحفظ أيضًا في data/sessions.json وتُقرأ عند
 *       بدء التشغيل، فتبقى صالحة حتى لو أعاد المضيف تشغيل العملية.
 *
 *  4) كلمة المرور الافتراضية كانت مكتوبة بصيغة JS فيها شرطة مائلة زائدة
 *     ('sadiq\\@1988') وهذا يجعل كلمة المرور الفعلية "sadiq\@1988" (بشرطة
 *     مائلة حقيقية داخلها) — مربكة وسهلة الكتابة الخاطئة.
 *     ← الحل: كلمة مرور ابتدائية نظيفة بدون رموز مربكة، ويُنصح بتغييرها فورًا.
 *
 *  5) لا وجود لروابط التواصل الاجتماعي في نموذج البيانات ولا في الواجهة.
 *     ← الحل: أضفنا contact.social (فيسبوك، إنستغرام، إكس/تويتر، يوتيوب،
 *       تيك توك، تيليجرام، قناة واتساب) قابلة للتعديل من لوحة الإدارة.
 *
 *  6) مشكلة "الرابط لا ينتهي بالدومين بشكل صحيح" غالبًا مرتبطة أيضًا بالنقطة
 *     رقم 1 (لا توجد صفحة لعرضها). أضفنا كذلك دعم BASE_PATH عبر متغير بيئة
 *     APP_BASE_PATH لحالات الاستضافة داخل مسار فرعي مثل example.com/foundation
 *     (يُستخدم بحذر: تحقق أيضًا من إعدادات الاستضافة/الدومين، فبعض هذه
 *     المشاكل تكون من جهة الاستضافة لا من الكود نفسه).
 * ==========================================================================
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const PORT = Number(process.env.PORT || 3000);
// إذا كان الموقع يعمل داخل مسار فرعي (مثل example.com/foundation) اضبط
// APP_BASE_PATH=/foundation قبل تشغيل الخادم. اتركه فارغًا إن كان الموقع
// يعمل من جذر الدومين مباشرة (الحالة الأكثر شيوعًا).
const BASE_PATH = String(process.env.APP_BASE_PATH || '').replace(/\/+$/, '');

const INITIAL_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'sadiq1988';
// كلمة المرور الابتدائية. غيّرها فورًا من لوحة الإدارة (الحساب) بعد أول دخول،
// أو حدّد ADMIN_PASSWORD كمتغير بيئة قبل أول تشغيل للخادم.
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Sadiq@1988';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 7 * 1024 * 1024;
const sessions = new Map();
let sessionsDirty = false;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* ------------------------------------------------------------------ */
/* المحتوى الافتراضي                                                    */
/* ------------------------------------------------------------------ */
function defaultContent() {
  return {
    settings: {
      siteName: 'مؤسسة ملتقى العلم والثقافية',
      tagline: 'معًا نصنع أثرًا معرفيًا وثقافيًا مستدامًا',
      heroTitle: 'العلم والثقافة… مساحة تلتقي فيها الأفكار',
      heroText: 'نعمل على بناء مجتمع واعٍ ومبدع عبر برامج معرفية وأنشطة ثقافية ومراكز قريبة من الناس.',
      logo: '/assets/logo.svg',
      heroImage: '/assets/logo.svg'
    },
    activities: [
      {
        id: crypto.randomUUID(),
        title: 'الملتقى الثقافي الأسبوعي',
        details: 'جلسة حوارية مفتوحة تجمع المهتمين بالمعرفة والفكر والثقافة.',
        date: 'كل يوم سبت',
        category: 'ثقافي',
        image: '/assets/logo.svg'
      },
      {
        id: crypto.randomUUID(),
        title: 'برنامج القراءة الواعية',
        details: 'رحلة قراءة جماعية تناقش الكتب المؤثرة وتحوّل الأفكار إلى ممارسة.',
        date: 'شهريًا',
        category: 'معرفي',
        image: '/assets/logo.svg'
      },
      {
        id: crypto.randomUUID(),
        title: 'ورش مهارات الشباب',
        details: 'ورش عملية في التواصل والقيادة والتخطيط لصناعة مبادرات مجتمعية ناجحة.',
        date: 'حسب الإعلان',
        category: 'تدريبي',
        image: '/assets/logo.svg'
      }
    ],
    centers: [
      {
        id: crypto.randomUUID(),
        name: 'المركز الثقافي الرئيس',
        city: 'يُحدَّد من لوحة الإدارة',
        details: 'مساحة للقراءة والندوات والبرامج التدريبية واللقاءات المجتمعية.',
        manager: 'إدارة المؤسسة',
        hours: 'السبت–الخميس | 9 ص – 6 م',
        phone: '',
        images: [],
        videos: []
      }
    ],
    gallery: [
      {
        id: crypto.randomUUID(),
        title: 'هوية المؤسسة',
        caption: 'شعار مؤسسة ملتقى العلم والثقافية',
        image: '/assets/logo.svg'
      }
    ],
    contact: {
      address: 'أضف عنوان المؤسسة من لوحة الإدارة',
      phone: '',
      whatsapp: '',
      email: '',
      workHours: 'السبت–الخميس | 9 ص – 6 م',
      mapUrl: '',
      social: {
        facebook: '',
        instagram: '',
        x: '',
        youtube: '',
        tiktok: '',
        telegram: '',
        whatsappChannel: ''
      }
    },
    messages: []
  };
}

async function ensureDataFiles() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    const existing = await readJson(CONTENT_FILE);
    // ترقية هادئة: إن كان الملف موجودًا من نسخة سابقة بدون حقل social، أضفه.
    if (existing.contact && !existing.contact.social) {
      existing.contact.social = defaultContent().contact.social;
      await writeJson(CONTENT_FILE, existing);
    }
  } catch {
    await writeJson(CONTENT_FILE, defaultContent());
  }
  try { await fs.access(ADMIN_FILE); } catch {
    const salt = crypto.randomBytes(16).toString('hex');
    await writeJson(ADMIN_FILE, {
      username: INITIAL_ADMIN_USERNAME,
      salt,
      passwordHash: hashPassword(INITIAL_ADMIN_PASSWORD, salt)
    });
  }
}

/* ------------------------------------------------------------------ */
/* أدوات عامة                                                            */
/* ------------------------------------------------------------------ */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function secureEqual(first, second) {
  const a = Buffer.from(first, 'hex');
  const b = Buffer.from(second, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, file);
}

async function getContent() { return readJson(CONTENT_FILE); }
async function saveContent(content) { return writeJson(CONTENT_FILE, content); }

function sendJson(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(JSON.stringify(body));
}

function sendError(res, status, message) { sendJson(res, status, { error: message }); }

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

/* ------------------------------------------------------------------ */
/* الجلسات — تُحفظ الآن على القرص كي لا تُفقد عند إعادة تشغيل العملية       */
/* ------------------------------------------------------------------ */
async function loadSessions() {
  try {
    const raw = await readJson(SESSIONS_FILE);
    const now = Date.now();
    for (const token of Object.keys(raw)) {
      if (raw[token] && raw[token].expiresAt > now) sessions.set(token, raw[token]);
    }
  } catch { /* لا يوجد ملف جلسات بعد — طبيعي عند أول تشغيل */ }
}

async function persistSessions() {
  const plain = {};
  for (const [token, session] of sessions) plain[token] = session;
  await writeJson(SESSIONS_FILE, plain).catch(() => {});
}

function getSession(req) {
  const token = parseCookies(req).session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    sessionsDirty = true;
    return null;
  }
  return Object.assign({ token }, session);
}

function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session) {
    sendError(res, 401, 'يجب تسجيل الدخول كمسؤول أولًا.');
    return null;
  }
  return session;
}

function makeSession(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  sessionsDirty = true;
  return token;
}

function sessionCookie(token, clear) {
  const maxAge = clear ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.FORCE_HTTPS === '1' ? '; Secure' : '';
  return 'session=' + encodeURIComponent(token || '') + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + secure;
}

/* ------------------------------------------------------------------ */
/* قراءة الجسم والتحقق من الحقول                                        */
/* ------------------------------------------------------------------ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(Object.assign(new Error('الطلب كبير جدًا. الحد الأقصى للصورة 5 ميغابايت.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('بيانات الطلب غير صالحة.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function text(value, field, max, required) {
  max = max || 2000;
  const result = String(value == null ? '' : value).trim();
  if (required && !result) throw Object.assign(new Error('حقل «' + field + '» مطلوب.'), { status: 400 });
  if (result.length > max) throw Object.assign(new Error('حقل «' + field + '» أطول من اللازم.'), { status: 400 });
  return result;
}

function imageUrl(value) {
  const result = text(value, 'الصورة', 500, false);
  if (result && !result.startsWith('/') && !/^https?:\/\//i.test(result)) {
    throw Object.assign(new Error('رابط الصورة غير صالح.'), { status: 400 });
  }
  return result;
}

function imageList(value) {
  let images = value;
  if (typeof images === 'string') {
    try { images = JSON.parse(images || '[]'); } catch { images = []; }
  }
  if (!Array.isArray(images)) return [];
  if (images.length > 30) throw Object.assign(new Error('يمكن إضافة 30 صورة للمركز كحد أقصى.'), { status: 400 });
  return images.map(imageUrl).filter(Boolean);
}

function videoList(value) {
  let videos = value;
  if (typeof videos === 'string') {
    try { videos = JSON.parse(videos || '[]'); } catch { videos = []; }
  }
  if (!Array.isArray(videos)) return [];
  if (videos.length > 20) throw Object.assign(new Error('يمكن إضافة 20 فيديو للمركز كحد أقصى.'), { status: 400 });
  return videos.map((video) => {
    const result = text(video, 'رابط الفيديو', 500, false);
    if (result && !result.startsWith('/') && !/^https?:\/\//i.test(result)) {
      throw Object.assign(new Error('رابط الفيديو غير صالح.'), { status: 400 });
    }
    return result;
  }).filter(Boolean);
}

function externalUrl(value, field, required) {
  const result = text(value, field, 500, required);
  if (!result) return '';
  try {
    const url = new URL(result);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href;
  } catch {
    throw Object.assign(new Error('حقل «' + field + '» يجب أن يكون رابطًا يبدأ بـ http أو https.'), { status: 400 });
  }
}

function normaliseActivity(body) {
  return {
    title: text(body.title, 'عنوان النشاط', 120, true),
    details: text(body.details, 'وصف النشاط', 1200, true),
    date: text(body.date, 'موعد النشاط', 100, true),
    category: text(body.category, 'التصنيف', 60, true),
    image: imageUrl(body.image)
  };
}

function normaliseCenter(body) {
  return {
    name: text(body.name, 'اسم المركز', 120, true),
    city: text(body.city, 'المدينة أو الموقع', 120, true),
    details: text(body.details, 'وصف المركز', 1200, true),
    manager: text(body.manager, 'المسؤول', 120),
    hours: text(body.hours, 'ساعات العمل', 120),
    phone: text(body.phone, 'الهاتف', 60),
    images: imageList(body.images),
    videos: videoList(body.videos)
  };
}

function normaliseGallery(body) {
  return {
    title: text(body.title, 'عنوان الصورة', 120, true),
    caption: text(body.caption, 'وصف الصورة', 500),
    image: imageUrl(body.image) || '/assets/logo.svg'
  };
}

function normaliseSettings(body) {
  return {
    siteName: text(body.siteName, 'اسم المؤسسة', 120, true),
    tagline: text(body.tagline, 'العبارة المختصرة', 180, true),
    heroTitle: text(body.heroTitle, 'عنوان الواجهة', 180, true),
    heroText: text(body.heroText, 'نص الواجهة', 1000, true),
    logo: imageUrl(body.logo) || '/assets/logo.svg',
    heroImage: imageUrl(body.heroImage) || '/assets/logo.svg'
  };
}

function normaliseSocial(body) {
  const social = body && typeof body === 'object' ? body : {};
  return {
    facebook: externalUrl(social.facebook, 'فيسبوك', false),
    instagram: externalUrl(social.instagram, 'إنستغرام', false),
    x: externalUrl(social.x, 'إكس (تويتر)', false),
    youtube: externalUrl(social.youtube, 'يوتيوب', false),
    tiktok: externalUrl(social.tiktok, 'تيك توك', false),
    telegram: externalUrl(social.telegram, 'تيليجرام', false),
    whatsappChannel: externalUrl(social.whatsappChannel, 'قناة واتساب', false)
  };
}

function normaliseContact(body) {
  return {
    address: text(body.address, 'العنوان', 300),
    phone: text(body.phone, 'الهاتف', 60),
    whatsapp: text(body.whatsapp, 'واتساب', 60),
    email: text(body.email, 'البريد الإلكتروني', 160),
    workHours: text(body.workHours, 'ساعات العمل', 160),
    mapUrl: body.mapUrl ? externalUrl(body.mapUrl, 'رابط الخريطة', false) : '',
    social: normaliseSocial(body.social)
  };
}

/* ------------------------------------------------------------------ */
/* الرفع                                                                 */
/* ------------------------------------------------------------------ */
async function handleUpload(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req);
  const dataUrl = text(body.dataUrl, 'ملف الصورة', MAX_JSON_BYTES, true);
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(new Error('يُسمح فقط بصور PNG أو JPG أو WEBP أو GIF.'), { status: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw Object.assign(new Error('حجم الصورة يجب ألا يتجاوز 5 ميغابايت.'), { status: 413 });
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[match[1]];
  const filename = Date.now() + '-' + crypto.randomUUID().slice(0, 8) + '.' + extension;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  sendJson(res, 201, { url: '/uploads/' + filename });
}

/* ------------------------------------------------------------------ */
/* CRUD عام للأنشطة / المراكز / المعرض                                   */
/* ------------------------------------------------------------------ */
async function handleResource(req, res, pathname, resource, normalise) {
  if (!requireAdmin(req, res)) return;
  const base = '/api/' + resource;
  const rest = pathname.slice(base.length).replace(/^\//, '');
  const content = await getContent();
  if (!Array.isArray(content[resource])) content[resource] = [];

  if (req.method === 'POST' && !rest) {
    const record = Object.assign({ id: crypto.randomUUID() }, normalise(await readBody(req)));
    content[resource].unshift(record);
    await saveContent(content);
    return sendJson(res, 201, { item: record });
  }
  const id = decodeURIComponent(rest);
  const index = content[resource].findIndex((item) => item.id === id);
  if (index < 0) return sendError(res, 404, 'العنصر المطلوب غير موجود.');
  if (req.method === 'PUT') {
    const record = Object.assign({ id }, normalise(await readBody(req)));
    content[resource][index] = record;
    await saveContent(content);
    return sendJson(res, 200, { item: record });
  }
  if (req.method === 'DELETE') {
    content[resource].splice(index, 1);
    await saveContent(content);
    return sendJson(res, 200, { ok: true });
  }
  return sendError(res, 405, 'طريقة الطلب غير مدعومة.');
}

/* ------------------------------------------------------------------ */
/* توجيه API                                                             */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/content') {
    const full = await getContent();
    const messages = full.messages; // eslint-disable-line no-unused-vars
    const publicContent = { settings: full.settings, activities: full.activities, centers: full.centers, gallery: full.gallery, contact: full.contact };
    return sendJson(res, 200, publicContent);
  }
  if (req.method === 'GET' && pathname === '/api/session') {
    const session = getSession(req);
    return sendJson(res, 200, { authenticated: Boolean(session), username: session ? session.username : '' });
  }
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    const admin = await readJson(ADMIN_FILE);
    const usernameOk = text(body.username, 'اسم المستخدم', 60, true) === admin.username;
    const passwordOk = usernameOk && secureEqual(hashPassword(String(body.password == null ? '' : body.password), admin.salt), admin.passwordHash);
    if (!passwordOk) return sendError(res, 401, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
    const token = makeSession(admin.username);
    await persistSessions();
    return sendJson(res, 200, { ok: true, username: admin.username }, { 'Set-Cookie': sessionCookie(token) });
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    const session = getSession(req);
    if (session) { sessions.delete(session.token); await persistSessions(); }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', true) });
  }
  if (req.method === 'POST' && pathname === '/api/upload') return handleUpload(req, res);

  if (req.method === 'PUT' && pathname === '/api/settings') {
    if (!requireAdmin(req, res)) return;
    const content = await getContent();
    content.settings = normaliseSettings(await readBody(req));
    await saveContent(content);
    return sendJson(res, 200, { settings: content.settings });
  }
  if (req.method === 'PUT' && pathname === '/api/contact') {
    if (!requireAdmin(req, res)) return;
    const content = await getContent();
    content.contact = normaliseContact(await readBody(req));
    await saveContent(content);
    return sendJson(res, 200, { contact: content.contact });
  }
  if (req.method === 'POST' && pathname === '/api/messages') {
    const body = await readBody(req);
    const message = {
      id: crypto.randomUUID(),
      name: text(body.name, 'الاسم', 100, true),
      phone: text(body.phone, 'الهاتف', 60),
      email: text(body.email, 'البريد الإلكتروني', 160),
      message: text(body.message, 'الرسالة', 2000, true),
      createdAt: new Date().toISOString()
    };
    const content = await getContent();
    content.messages = Array.isArray(content.messages) ? content.messages : [];
    content.messages.unshift(message);
    await saveContent(content);
    return sendJson(res, 201, { ok: true });
  }
  if (pathname === '/api/messages') {
    if (!requireAdmin(req, res)) return;
    const content = await getContent();
    if (req.method === 'GET') return sendJson(res, 200, { messages: content.messages || [] });
    return sendError(res, 405, 'طريقة الطلب غير مدعومة.');
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/messages/')) {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(pathname.slice('/api/messages/'.length));
    const content = await getContent();
    const index = (content.messages || []).findIndex((item) => item.id === id);
    if (index < 0) return sendError(res, 404, 'الرسالة غير موجودة.');
    content.messages.splice(index, 1);
    await saveContent(content);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'PUT' && pathname === '/api/account') {
    const session = requireAdmin(req, res);
    if (!session) return;
    const body = await readBody(req);
    const admin = await readJson(ADMIN_FILE);
    const oldHash = hashPassword(String(body.currentPassword == null ? '' : body.currentPassword), admin.salt);
    if (!secureEqual(oldHash, admin.passwordHash)) return sendError(res, 401, 'كلمة المرور الحالية غير صحيحة.');
    const username = text(body.username, 'اسم المستخدم', 60, true);
    if (!/^[A-Za-z0-9_.-]{3,60}$/.test(username)) return sendError(res, 400, 'استخدم حروفًا إنجليزية أو أرقامًا أو . _ - في اسم المستخدم.');
    const newPassword = text(body.newPassword, 'كلمة المرور الجديدة', 160, true);
    if (newPassword.length < 8) return sendError(res, 400, 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.');
    const salt = crypto.randomBytes(16).toString('hex');
    await writeJson(ADMIN_FILE, { username, salt, passwordHash: hashPassword(newPassword, salt) });
    sessions.set(session.token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
    await persistSessions();
    return sendJson(res, 200, { ok: true, username });
  }

  const resources = [['activities', normaliseActivity], ['centers', normaliseCenter], ['gallery', normaliseGallery]];
  for (const pair of resources) {
    const resource = pair[0];
    const normalise = pair[1];
    if (pathname === '/api/' + resource || pathname.startsWith('/api/' + resource + '/')) {
      return handleResource(req, res, pathname, resource, normalise);
    }
  }
  return sendError(res, 404, 'المسار المطلوب غير موجود.');
}

/* ------------------------------------------------------------------ */
/* تقديم الملفات الساكنة (الموقع + الصور المرفوعة)                        */
/* ------------------------------------------------------------------ */
const BASE_SCRIPT_TOKEN = '<!--APP_BASE-->';

async function sendHtmlWithBase(res, filePath) {
  const file = await fs.readFile(filePath, 'utf8');
  const script = '<script>window.APP_BASE=' + JSON.stringify(BASE_PATH) + ';</script>';
  const withBase = file.includes(BASE_SCRIPT_TOKEN) ? file.replace(BASE_SCRIPT_TOKEN, script) : file;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache'
  });
  res.end(withBase);
}

async function serveFromDir(res, dir, filePath, cache) {
  const resolved = path.resolve(dir, '.' + filePath);
  if (!resolved.startsWith(dir)) return sendError(res, 403, 'غير مسموح.');
  const file = await fs.readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cache
  });
  res.end(file);
}

async function serveStatic(res, pathnameRaw) {
  let pathname = pathnameRaw;
  // دعم الاستضافة داخل مسار فرعي: أزل البادئة إن كانت موجودة في الطلب
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) pathname = pathname.slice(BASE_PATH.length) || '/';

  if (pathname.startsWith('/uploads/')) {
    try { return await serveFromDir(res, UPLOAD_DIR, pathname.slice('/uploads'.length), 'public, max-age=3600'); }
    catch (error) { if (error.code === 'ENOENT') return sendError(res, 404, 'الملف غير موجود.'); throw error; }
  }

  if (pathname === '/' || pathname === '/index.html') {
    return sendHtmlWithBase(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
    return sendHtmlWithBase(res, path.join(PUBLIC_DIR, 'admin.html'));
  }

  try {
    return await serveFromDir(res, PUBLIC_DIR, pathname, 'public, max-age=3600');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // مسار غير معروف وليس ملفًا (بلا امتداد): أعد صفحة البداية بدل 404 صريح،
    // حتى لا يظهر الموقع "مكسورًا" عند فتح روابط فرعية غير متوقعة.
    if (!path.extname(pathname)) return sendHtmlWithBase(res, path.join(PUBLIC_DIR, 'index.html'));
    return sendError(res, 404, 'الصفحة غير موجودة.');
  }
}

/* ------------------------------------------------------------------ */
/* توليد ملفات الواجهة الأمامية (public/) تلقائيًا عند التشغيل            */
/* ------------------------------------------------------------------ */
const STYLES_CSS = [
'@import url("https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&family=Aref+Ruqaa:wght@400;700&display=swap");',
'',
':root{',
'  --ink:#0a1f4e;',
'  --teal:#0052a3;',
'  --teal-deep:#003d7a;',
'  --cream:#f5f8fc;',
'  --paper:#ffffff;',
'  --gold:#ffffff;',
'  --gold-soft:#cce5ff;',
'  --line:#dce7f5;',
'  --radius:10px;',
'  --max:1120px;',
'}',
'*{box-sizing:border-box;}',
'html{scroll-behavior:smooth;}',
'body{margin:0;background:var(--cream);color:var(--ink);font-family:"Tajawal",sans-serif;line-height:1.7;direction:rtl;}',
'h1,h2,h3,.display{font-family:"Aref Ruqaa","Tajawal",serif;font-weight:700;}',
'img{max-width:100%;display:block;}',
'a{color:inherit;}',
'.wrap{max-width:var(--max);margin:0 auto;padding:0 24px;}',
'.skip-link{position:absolute;right:-999px;top:0;background:var(--gold);color:#1c1200;padding:10px 16px;border-radius:0 0 0 8px;z-index:100;}',
'.skip-link:focus{right:0;}',
'header.site-header{background:var(--teal);color:#f4efe1;position:sticky;top:0;z-index:20;border-bottom:3px solid var(--gold);}',
'.header-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;}',
'.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:#f4efe1;}',
'.brand img{width:44px;height:44px;border-radius:8px;object-fit:cover;background:#fff;}',
'.brand-name{font-size:1.05rem;font-weight:700;font-family:"Aref Ruqaa",serif;}',
'.brand-tag{font-size:.75rem;color:var(--gold-soft);}',
'nav.main-nav{display:flex;gap:22px;font-size:.95rem;}',
'nav.main-nav a{text-decoration:none;padding:6px 2px;border-bottom:2px solid transparent;}',
'nav.main-nav a:hover{border-color:var(--gold);}',
'.nav-toggle{display:none;background:none;border:1px solid var(--gold-soft);color:#f4efe1;border-radius:8px;padding:8px 10px;font-size:1.1rem;}',
'section{padding:64px 0;}',
'section.alt{background:var(--paper);border-top:1px solid var(--line);border-bottom:1px solid var(--line);}',
'.eyebrow{color:var(--gold);font-weight:700;margin:0 0 6px;font-size:.95rem;}',
'.hero{background:linear-gradient(180deg,var(--teal) 0%,var(--teal-deep) 100%);color:#f4efe1;padding:76px 0 90px;position:relative;overflow:hidden;}',
'.hero::after{content:"";position:absolute;inset:auto -10% -60% auto;width:520px;height:520px;border:1px solid rgba(231,201,140,.25);border-radius:50%;}',
'.hero-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:48px;align-items:center;position:relative;}',
'.hero h1{font-size:clamp(2rem,4vw,2.9rem);margin:0 0 18px;line-height:1.35;}',
'.hero p{font-size:1.08rem;color:#dfe6df;max-width:46ch;margin:0 0 28px;}',
'.hero-actions{display:flex;gap:14px;flex-wrap:wrap;}',
'.btn{display:inline-block;padding:13px 26px;border-radius:999px;font-weight:700;text-decoration:none;transition:transform .15s ease;border:1px solid transparent;}',
'.btn:hover{transform:translateY(-2px);}',
'.btn-gold{background:var(--gold);color:#241800;}',
'.btn-outline{border-color:var(--gold-soft);color:#f4efe1;}',
'.hero-figure{border:1px solid rgba(231,201,140,.4);border-radius:16px;padding:14px;background:rgba(255,255,255,.04);}',
'.hero-figure img{border-radius:10px;width:100%;aspect-ratio:4/3;object-fit:cover;}',
'h2.section-title{font-size:1.9rem;margin:0 0 10px;}',
'.section-lead{color:#4b4438;max-width:60ch;margin:0 0 34px;}',
'.grid{display:grid;gap:22px;}',
'.grid-3{grid-template-columns:repeat(3,1fr);}',
'.grid-2{grid-template-columns:repeat(2,1fr);}',
'.card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;border-right:4px solid var(--gold);}',
'.card img{width:100%;aspect-ratio:16/10;object-fit:cover;}',
'.card-body{padding:18px 20px;}',
'.card-meta{display:flex;justify-content:space-between;font-size:.8rem;color:var(--gold);margin-bottom:8px;font-weight:700;}',
'.card h3{margin:0 0 8px;font-size:1.15rem;}',
'.card p{margin:0;color:#4b4438;font-size:.95rem;}',
'.center-block{display:grid;grid-template-columns:1fr 1fr;gap:26px;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:22px;margin-bottom:22px;}',
'.center-info h3{margin:0 0 6px;}',
'.center-meta{color:#6b6353;font-size:.9rem;margin:2px 0;}',
'.media-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;}',
'.media-row img{width:96px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line);}',
'.media-row a.video-chip{display:flex;align-items:center;justify-content:center;width:96px;height:72px;border-radius:8px;background:var(--teal);color:#f4efe1;font-size:.8rem;text-decoration:none;}',
'.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start;}',
'.contact-list{list-style:none;margin:0 0 22px;padding:0;display:flex;flex-direction:column;gap:10px;color:#3d372c;}',
'.social-row{display:flex;gap:10px;flex-wrap:wrap;}',
'.social-row a{width:42px;height:42px;border-radius:50%;background:var(--teal);color:#f4efe1;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:.85rem;border:1px solid var(--gold-soft);}',
'.social-row a:hover{background:var(--gold);color:#241800;}',
'form.contact-form{display:flex;flex-direction:column;gap:12px;}',
'.field label{display:block;font-size:.85rem;margin-bottom:5px;color:#3d372c;}',
'.field input,.field textarea,.field select{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:8px;font-family:inherit;font-size:.95rem;background:#fff;}',
'.field textarea{min-height:110px;resize:vertical;}',
'.form-note{font-size:.85rem;color:#6b6353;min-height:1.2em;}',
'footer.site-footer{background:var(--teal-deep);color:#cfd7cf;padding:36px 0 22px;font-size:.9rem;}',
'.footer-row{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px;}',
'.foot-links{display:flex;gap:16px;flex-wrap:wrap;}',
'.foot-links a{text-decoration:none;color:#cfd7cf;}',
'.foot-links a:hover{color:var(--gold-soft);}',
'@media (max-width:860px){',
'  nav.main-nav{position:fixed;inset:64px 0 auto 0;background:var(--teal);flex-direction:column;padding:18px 24px;gap:14px;display:none;border-bottom:3px solid var(--gold);}',
'  nav.main-nav.open{display:flex;}',
'  .nav-toggle{display:inline-block;}',
'  .hero-grid{grid-template-columns:1fr;}',
'  .grid-3{grid-template-columns:1fr;}',
'  .grid-2{grid-template-columns:1fr;}',
'  .center-block{grid-template-columns:1fr;}',
'  .contact-grid{grid-template-columns:1fr;}',
'}',
'/* ---- لوحة الإدارة ---- */',
'.admin-shell{min-height:100vh;background:var(--cream);}',
'.admin-login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}',
'.login-card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:36px 32px;width:100%;max-width:380px;border-top:4px solid var(--gold);}',
'.login-card h1{font-size:1.4rem;margin:0 0 4px;}',
'.login-card p{color:#6b6353;font-size:.9rem;margin:0 0 20px;}',
'.admin-top{background:var(--teal);color:#f4efe1;padding:14px 0;position:sticky;top:0;z-index:20;}',
'.admin-top .wrap{display:flex;justify-content:space-between;align-items:center;}',
'.admin-body{display:grid;grid-template-columns:220px 1fr;gap:0;max-width:var(--max);margin:0 auto;}',
'.admin-nav{padding:24px 16px;border-left:1px solid var(--line);display:flex;flex-direction:column;gap:4px;}',
'.admin-nav button{text-align:right;background:none;border:none;padding:10px 14px;border-radius:8px;font-family:inherit;font-size:.95rem;cursor:pointer;color:var(--ink);}',
'.admin-nav button.active,.admin-nav button:hover{background:var(--teal);color:#f4efe1;}',
'.admin-main{padding:28px 24px;min-width:0;}',
'.panel{display:none;}',
'.panel.active{display:block;}',
'.panel h2{margin-top:0;}',
'.toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:10px;}',
'.item-list{display:flex;flex-direction:column;gap:10px;margin-bottom:26px;}',
'.item-row{display:flex;align-items:center;gap:14px;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:10px 14px;}',
'.item-row img{width:56px;height:44px;object-fit:cover;border-radius:6px;flex:none;}',
'.item-row .info{flex:1;min-width:0;}',
'.item-row .info strong{display:block;font-size:.95rem;}',
'.item-row .info span{font-size:.8rem;color:#6b6353;}',
'.item-row .actions{display:flex;gap:8px;}',
'.mini-btn{border:1px solid var(--line);background:#fff;border-radius:6px;padding:6px 10px;font-size:.8rem;cursor:pointer;font-family:inherit;}',
'.mini-btn.danger{color:#a33;border-color:#e2b8b8;}',
'.mini-btn.primary{background:var(--teal);color:#fff;border-color:var(--teal);}',
'.card-form{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px;display:grid;gap:14px;grid-template-columns:1fr 1fr;}',
'.card-form .full{grid-column:1/-1;}',
'.card-form label{display:block;font-size:.85rem;margin-bottom:5px;color:#3d372c;}',
'.card-form input,.card-form textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-family:inherit;}',
'.card-form textarea{min-height:90px;resize:vertical;}',
'.upload-box{border:1.5px dashed var(--gold-soft);border-radius:10px;padding:14px;text-align:center;background:#fff;}',
'.upload-box input[type=file]{width:100%;}',
'.thumb-grid{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;}',
'.thumb{position:relative;width:78px;height:60px;}',
'.thumb img{width:100%;height:100%;object-fit:cover;border-radius:6px;}',
'.thumb button{position:absolute;top:-8px;left:-8px;width:20px;height:20px;border-radius:50%;background:#a33;color:#fff;border:none;font-size:.7rem;cursor:pointer;}',
'.chip-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}',
'.chip{display:flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--line);border-radius:999px;padding:5px 10px;font-size:.8rem;}',
'.chip button{border:none;background:none;color:#a33;cursor:pointer;font-size:.85rem;}',
'.form-actions{display:flex;gap:10px;grid-column:1/-1;}',
'.msg-banner{padding:10px 14px;border-radius:8px;font-size:.9rem;margin-bottom:14px;}',
'.msg-banner.error{background:#fbe4e4;color:#8a2a2a;}',
'.msg-banner.success{background:#e3f0e2;color:#2a5c2a;}',
'.table-simple{width:100%;border-collapse:collapse;}',
'.table-simple th,.table-simple td{text-align:right;padding:10px 8px;border-bottom:1px solid var(--line);font-size:.9rem;}',
'@media (max-width:760px){',
'  .admin-body{grid-template-columns:1fr;}',
'  .admin-nav{flex-direction:row;flex-wrap:wrap;border-left:none;border-bottom:1px solid var(--line);}',
'  .card-form{grid-template-columns:1fr;}',
'}'
].join('\n');

var APP_JS = [
'(function () {',
'  var BASE = window.APP_BASE || "";',
'  function api(p) { return BASE + p; }',
'  function el(tag, attrs, children) {',
'    var node = document.createElement(tag);',
'    attrs = attrs || {};',
'    for (var k in attrs) {',
'      if (k === "text") node.textContent = attrs[k];',
'      else if (k === "html") node.innerHTML = attrs[k];',
'      else node.setAttribute(k, attrs[k]);',
'    }',
'    (children || []).forEach(function (c) { if (c) node.appendChild(c); });',
'    return node;',
'  }',
'  function escapeAttr(value) { return String(value || "").replace(/"/g, "&quot;"); }',
'',
'  function renderSettings(settings) {',
'    document.title = settings.siteName + " — " + settings.tagline;',
'    document.querySelectorAll("[data-site-name]").forEach(function (n) { n.textContent = settings.siteName; });',
'    document.querySelectorAll("[data-tagline]").forEach(function (n) { n.textContent = settings.tagline; });',
'    document.querySelectorAll("[data-hero-title]").forEach(function (n) { n.textContent = settings.heroTitle; });',
'    document.querySelectorAll("[data-hero-text]").forEach(function (n) { n.textContent = settings.heroText; });',
'    document.querySelectorAll("[data-logo]").forEach(function (n) { n.src = settings.logo; });',
'    document.querySelectorAll("[data-hero-image]").forEach(function (n) { n.src = settings.heroImage; });',
'  }',
'',
'  function renderActivities(list) {',
'    var wrap = document.getElementById("activities-grid");',
'    if (!wrap) return;',
'    wrap.innerHTML = "";',
'    if (!list.length) { wrap.appendChild(el("p", { text: "سيتم نشر الأنشطة القادمة قريبًا." })); return; }',
'    list.forEach(function (item) {',
'      var card = el("article", { class: "card" }, [',
'        el("img", { src: item.image || "/assets/logo.svg", alt: item.title, loading: "lazy" }),',
'        el("div", { class: "card-body" }, [',
'          el("div", { class: "card-meta" }, [el("span", { text: item.category }), el("span", { text: item.date })]),',
'          el("h3", { text: item.title }),',
'          el("p", { text: item.details })',
'        ])',
'      ]);',
'      wrap.appendChild(card);',
'    });',
'  }',
'',
'  function renderCenters(list) {',
'    var wrap = document.getElementById("centers-list");',
'    if (!wrap) return;',
'    wrap.innerHTML = "";',
'    if (!list.length) { wrap.appendChild(el("p", { text: "سيتم الإعلان عن مراكز المؤسسة قريبًا." })); return; }',
'    list.forEach(function (item) {',
'      var mediaRow = el("div", { class: "media-row" });',
'      (item.images || []).forEach(function (src) { mediaRow.appendChild(el("img", { src: src, alt: item.name, loading: "lazy" })); });',
'      (item.videos || []).forEach(function (src) {',
'        var a = el("a", { class: "video-chip", href: src, target: "_blank", rel: "noopener" });',
'        a.textContent = "▶ فيديو";',
'        mediaRow.appendChild(a);',
'      });',
'      var info = el("div", { class: "center-info" }, [',
'        el("h3", { text: item.name }),',
'        el("p", { class: "center-meta", text: item.city }),',
'        el("p", { text: item.details }),',
'        item.manager ? el("p", { class: "center-meta", text: "المسؤول: " + item.manager }) : null,',
'        item.hours ? el("p", { class: "center-meta", text: "أوقات الدوام: " + item.hours }) : null,',
'        item.phone ? el("p", { class: "center-meta", text: "الهاتف: " + item.phone }) : null',
'      ]);',
'      wrap.appendChild(el("div", { class: "center-block" }, [info, mediaRow]));',
'    });',
'  }',
'',
'  function renderGallery(list) {',
'    var wrap = document.getElementById("gallery-grid");',
'    if (!wrap) return;',
'    wrap.innerHTML = "";',
'    list.forEach(function (item) {',
'      wrap.appendChild(el("article", { class: "card" }, [',
'        el("img", { src: item.image, alt: item.title, loading: "lazy" }),',
'        el("div", { class: "card-body" }, [el("h3", { text: item.title }), el("p", { text: item.caption })])',
'      ]));',
'    });',
'  }',
'',
'  var SOCIAL_LABELS = { facebook: "فيسبوك", instagram: "إنستغرام", x: "إكس", youtube: "يوتيوب", tiktok: "تيك توك", telegram: "تيليجرام", whatsappChannel: "واتساب" };',
'  var SOCIAL_ICONS = { facebook: "f", instagram: "ig", x: "x", youtube: "yt", tiktok: "tt", telegram: "tg", whatsappChannel: "wa" };',
'',
'  function renderContact(contact) {',
'    var list = document.getElementById("contact-list");',
'    if (list) {',
'      list.innerHTML = "";',
'      var rows = [];',
'      if (contact.address) rows.push(["العنوان", contact.address]);',
'      if (contact.phone) rows.push(["الهاتف", contact.phone]);',
'      if (contact.whatsapp) rows.push(["واتساب", contact.whatsapp]);',
'      if (contact.email) rows.push(["البريد الإلكتروني", contact.email]);',
'      if (contact.workHours) rows.push(["أوقات الدوام", contact.workHours]);',
'      rows.forEach(function (r) { list.appendChild(el("li", { text: r[0] + ": " + r[1] })); });',
'    }',
'    var socialWrap = document.getElementById("social-row");',
'    if (socialWrap) {',
'      socialWrap.innerHTML = "";',
'      var social = contact.social || {};',
'      Object.keys(SOCIAL_LABELS).forEach(function (key) {',
'        if (!social[key]) return;',
'        var a = el("a", { href: social[key], target: "_blank", rel: "noopener", title: SOCIAL_LABELS[key] });',
'        a.textContent = SOCIAL_ICONS[key];',
'        socialWrap.appendChild(a);',
'      });',
'    }',
'    document.querySelectorAll("[data-footer-social]").forEach(function (wrap) {',
'      wrap.innerHTML = "";',
'      var social = contact.social || {};',
'      Object.keys(SOCIAL_LABELS).forEach(function (key) {',
'        if (!social[key]) return;',
'        var a = el("a", { href: social[key], target: "_blank", rel: "noopener" });',
'        a.textContent = SOCIAL_LABELS[key];',
'        wrap.appendChild(a);',
'      });',
'    });',
'    var mapLink = document.getElementById("map-link");',
'    if (mapLink) { if (contact.mapUrl) { mapLink.href = contact.mapUrl; mapLink.style.display = ""; } else { mapLink.style.display = "none"; } }',
'  }',
'',
'  function loadContent() {',
'    fetch(api("/api/content")).then(function (r) { return r.json(); }).then(function (data) {',
'      renderSettings(data.settings);',
'      renderActivities(data.activities || []);',
'      renderCenters(data.centers || []);',
'      renderGallery(data.gallery || []);',
'      renderContact(data.contact || {});',
'    }).catch(function () {});',
'  }',
'',
'  function setupNav() {',
'    var toggle = document.querySelector(".nav-toggle");',
'    var nav = document.querySelector("nav.main-nav");',
'    if (toggle && nav) toggle.addEventListener("click", function () { nav.classList.toggle("open"); });',
'  }',
'',
'  function setupContactForm() {',
'    var form = document.getElementById("contact-form");',
'    if (!form) return;',
'    var note = document.getElementById("contact-form-note");',
'    form.addEventListener("submit", function (e) {',
'      e.preventDefault();',
'      var payload = {',
'        name: form.name.value,',
'        phone: form.phone.value,',
'        email: form.email.value,',
'        message: form.message.value',
'      };',
'      note.textContent = "جارٍ الإرسال…";',
'      fetch(api("/api/messages"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })',
'        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })',
'        .then(function (res) {',
'          if (!res.ok) { note.textContent = res.d.error || "تعذّر إرسال الرسالة."; return; }',
'          note.textContent = "تم إرسال رسالتك بنجاح، سنتواصل معك قريبًا.";',
'          form.reset();',
'        }).catch(function () { note.textContent = "تعذّر الاتصال بالخادم."; });',
'    });',
'  }',
'',
'  document.addEventListener("DOMContentLoaded", function () {',
'    setupNav();',
'    setupContactForm();',
'    loadContent();',
'  });',
'})();'
].join('\n');

var INDEX_HTML = [
'<!DOCTYPE html>',
'<html lang="ar" dir="rtl">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>مؤسسة ملتقى العلم والثقافية</title>',
'<meta name="description" content="مؤسسة ملتقى العلم والثقافية — أنشطة معرفية وثقافية ومراكز مجتمعية">',
'<link rel="stylesheet" href="/styles.css">',
'<!--APP_BASE-->',
'</head>',
'<body>',
'<a class="skip-link" href="#main">تخطَّ إلى المحتوى</a>',
'<header class="site-header">',
'  <div class="wrap header-row">',
'    <a class="brand" href="/">',
'      <img data-logo src="/assets/logo.svg" alt="شعار المؤسسة">',
'      <span>',
'        <span class="brand-name" data-site-name>مؤسسة ملتقى العلم والثقافية</span><br>',
'        <span class="brand-tag" data-tagline>معًا نصنع أثرًا معرفيًا وثقافيًا مستدامًا</span>',
'      </span>',
'    </a>',
'    <button class="nav-toggle" aria-label="فتح القائمة">☰</button>',
'    <nav class="main-nav">',
'      <a href="#activities">الأنشطة</a>',
'      <a href="#centers">المراكز</a>',
'      <a href="#gallery">المعرض</a>',
'      <a href="#contact">تواصل معنا</a>',
'      <a href="/admin">لوحة الإدارة</a>',
'    </nav>',
'  </div>',
'</header>',
'',
'<main id="main">',
'  <section class="hero">',
'    <div class="wrap hero-grid">',
'      <div>',
'        <p class="eyebrow">مؤسسة أهلية للعمل المعرفي والثقافي</p>',
'        <h1 data-hero-title>العلم والثقافة… مساحة تلتقي فيها الأفكار</h1>',
'        <p data-hero-text>نعمل على بناء مجتمع واعٍ ومبدع عبر برامج معرفية وأنشطة ثقافية ومراكز قريبة من الناس.</p>',
'        <div class="hero-actions">',
'          <a class="btn btn-gold" href="#activities">تصفّح الأنشطة</a>',
'          <a class="btn btn-outline" href="#contact">تواصل معنا</a>',
'        </div>',
'      </div>',
'      <div class="hero-figure"><img data-hero-image src="/assets/logo.svg" alt="صورة تعريفية بالمؤسسة"></div>',
'    </div>',
'  </section>',
'',
'  <section id="activities">',
'    <div class="wrap">',
'      <p class="eyebrow">فعاليات المؤسسة</p>',
'      <h2 class="section-title">الأنشطة والبرامج</h2>',
'      <p class="section-lead">مجموعة من الأنشطة المعرفية والثقافية والتدريبية التي تنظمها المؤسسة بشكل دوري.</p>',
'      <div class="grid grid-3" id="activities-grid"></div>',
'    </div>',
'  </section>',
'',
'  <section id="centers" class="alt">',
'    <div class="wrap">',
'      <p class="eyebrow">حضور ميداني</p>',
'      <h2 class="section-title">مراكز المؤسسة</h2>',
'      <p class="section-lead">مساحات المؤسسة القريبة من المجتمع، بصورها وفيديوهاتها ومعلومات التواصل الخاصة بكل مركز.</p>',
'      <div id="centers-list"></div>',
'    </div>',
'  </section>',
'',
'  <section id="gallery">',
'    <div class="wrap">',
'      <p class="eyebrow">من أرشيفنا</p>',
'      <h2 class="section-title">معرض الصور</h2>',
'      <div class="grid grid-3" id="gallery-grid"></div>',
'    </div>',
'  </section>',
'',
'  <section id="contact" class="alt">',
'    <div class="wrap contact-grid">',
'      <div>',
'        <p class="eyebrow">ابقَ على تواصل</p>',
'        <h2 class="section-title">تواصل معنا</h2>',
'        <ul class="contact-list" id="contact-list"></ul>',
'        <div class="social-row" id="social-row"></div>',
'        <p style="margin-top:16px;"><a id="map-link" class="btn btn-outline" href="#" target="_blank" rel="noopener" style="display:none;">افتح الموقع على الخريطة</a></p>',
'      </div>',
'      <form class="contact-form" id="contact-form">',
'        <div class="field"><label for="f-name">الاسم</label><input id="f-name" name="name" required maxlength="100"></div>',
'        <div class="field"><label for="f-phone">رقم الهاتف</label><input id="f-phone" name="phone" maxlength="60"></div>',
'        <div class="field"><label for="f-email">البريد الإلكتروني</label><input id="f-email" name="email" type="email" maxlength="160"></div>',
'        <div class="field"><label for="f-message">رسالتك</label><textarea id="f-message" name="message" required maxlength="2000"></textarea></div>',
'        <button class="btn btn-gold" type="submit">إرسال الرسالة</button>',
'        <p class="form-note" id="contact-form-note"></p>',
'      </form>',
'    </div>',
'  </section>',
'</main>',
'',
'<footer class="site-footer">',
'  <div class="wrap footer-row">',
'    <span>© <span id="year"></span> <span data-site-name>مؤسسة ملتقى العلم والثقافية</span></span>',
'    <div class="foot-links" data-footer-social></div>',
'  </div>',
'</footer>',
'<script>document.getElementById("year").textContent = new Date().getFullYear();</script>',
'<script src="/app.js"></script>',
'</body>',
'</html>'
].join('\n');

var ADMIN_JS = [
'(function () {',
'  var BASE = window.APP_BASE || "";',
'  function api(p) { return BASE + p; }',
'  function $(sel, root) { return (root || document).querySelector(sel); }',
'  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }',
'',
'  function request(url, options) {',
'    options = options || {};',
'    options.credentials = "same-origin";',
'    return fetch(api(url), options).then(function (r) {',
'      return r.json().catch(function () { return {}; }).then(function (data) {',
'        if (!r.ok) throw new Error(data.error || "حدث خطأ غير متوقع.");',
'        return data;',
'      });',
'    });',
'  }',
'  function postJson(url, method, body) {',
'    return request(url, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });',
'  }',
'',
'  function fileToDataUrl(file) {',
'    return new Promise(function (resolve, reject) {',
'      var reader = new FileReader();',
'      reader.onload = function () { resolve(reader.result); };',
'      reader.onerror = reject;',
'      reader.readAsDataURL(file);',
'    });',
'  }',
'  function uploadFile(file) {',
'    return fileToDataUrl(file).then(function (dataUrl) {',
'      return postJson("/api/upload", "POST", { dataUrl: dataUrl });',
'    }).then(function (res) { return res.url; });',
'  }',
'',
'  /* ---------------- تسجيل الدخول ---------------- */',
'  function showLogin(message) {',
'    $("#admin-shell").style.display = "none";',
'    $("#admin-login").style.display = "flex";',
'    $("#login-error").textContent = message || "";',
'  }',
'  function showShell() {',
'    $("#admin-login").style.display = "none";',
'    $("#admin-shell").style.display = "block";',
'    loadAll();',
'  }',
'',
'  $("#login-form").addEventListener("submit", function (e) {',
'    e.preventDefault();',
'    var form = e.target;',
'    postJson("/api/login", "POST", { username: form.username.value, password: form.password.value })',
'      .then(function (res) { $("#top-username").textContent = res.username; showShell(); })',
'      .catch(function (err) { $("#login-error").textContent = err.message; });',
'  });',
'',
'  $("#logout-btn").addEventListener("click", function () {',
'    postJson("/api/logout", "POST", {}).finally(function () { showLogin(""); });',
'  });',
'',
'  /* ---------------- التنقل بين الألسنة ---------------- */',
'  $all(".admin-nav button").forEach(function (btn) {',
'    btn.addEventListener("click", function () {',
'      $all(".admin-nav button").forEach(function (b) { b.classList.remove("active"); });',
'      $all(".panel").forEach(function (p) { p.classList.remove("active"); });',
'      btn.classList.add("active");',
'      $("#panel-" + btn.dataset.panel).classList.add("active");',
'    });',
'  });',
'',
'  function banner(container, text, type) {',
'    var b = $(".msg-banner", container);',
'    if (!b) { b = document.createElement("div"); b.className = "msg-banner"; container.insertBefore(b, container.firstChild); }',
'    b.textContent = text;',
'    b.className = "msg-banner " + (type || "success");',
'    setTimeout(function () { b.remove(); }, 4000);',
'  }',
'',
'  /* ---------------- الإعدادات ---------------- */',
'  var settingsForm = $("#settings-form");',
'  function fillSettings(s) {',
'    settingsForm.siteName.value = s.siteName || "";',
'    settingsForm.tagline.value = s.tagline || "";',
'    settingsForm.heroTitle.value = s.heroTitle || "";',
'    settingsForm.heroText.value = s.heroText || "";',
'    $("#settings-logo-preview").src = s.logo || "/assets/logo.svg";',
'    $("#settings-hero-preview").src = s.heroImage || "/assets/logo.svg";',
'    settingsForm.dataset.logo = s.logo || "/assets/logo.svg";',
'    settingsForm.dataset.heroImage = s.heroImage || "/assets/logo.svg";',
'  }',
'  $("#settings-logo-input").addEventListener("change", function (e) {',
'    var f = e.target.files[0]; if (!f) return;',
'    uploadFile(f).then(function (url) { settingsForm.dataset.logo = url; $("#settings-logo-preview").src = url; });',
'  });',
'  $("#settings-hero-input").addEventListener("change", function (e) {',
'    var f = e.target.files[0]; if (!f) return;',
'    uploadFile(f).then(function (url) { settingsForm.dataset.heroImage = url; $("#settings-hero-preview").src = url; });',
'  });',
'  settingsForm.addEventListener("submit", function (e) {',
'    e.preventDefault();',
'    postJson("/api/settings", "PUT", {',
'      siteName: settingsForm.siteName.value,',
'      tagline: settingsForm.tagline.value,',
'      heroTitle: settingsForm.heroTitle.value,',
'      heroText: settingsForm.heroText.value,',
'      logo: settingsForm.dataset.logo,',
'      heroImage: settingsForm.dataset.heroImage',
'    }).then(function () { banner(settingsForm, "تم حفظ الإعدادات."); }).catch(function (err) { banner(settingsForm, err.message, "error"); });',
'  });',
'',
'  /* ---------------- التواصل + التواصل الاجتماعي ---------------- */',
'  var contactForm = $("#contact-form-admin");',
'  function fillContact(c) {',
'    contactForm.address.value = c.address || "";',
'    contactForm.phone.value = c.phone || "";',
'    contactForm.whatsapp.value = c.whatsapp || "";',
'    contactForm.email.value = c.email || "";',
'    contactForm.workHours.value = c.workHours || "";',
'    contactForm.mapUrl.value = c.mapUrl || "";',
'    var s = c.social || {};',
'    ["facebook", "instagram", "x", "youtube", "tiktok", "telegram", "whatsappChannel"].forEach(function (key) {',
'      if (contactForm["social_" + key]) contactForm["social_" + key].value = s[key] || "";',
'    });',
'  }',
'  contactForm.addEventListener("submit", function (e) {',
'    e.preventDefault();',
'    postJson("/api/contact", "PUT", {',
'      address: contactForm.address.value,',
'      phone: contactForm.phone.value,',
'      whatsapp: contactForm.whatsapp.value,',
'      email: contactForm.email.value,',
'      workHours: contactForm.workHours.value,',
'      mapUrl: contactForm.mapUrl.value,',
'      social: {',
'        facebook: contactForm.social_facebook.value,',
'        instagram: contactForm.social_instagram.value,',
'        x: contactForm.social_x.value,',
'        youtube: contactForm.social_youtube.value,',
'        tiktok: contactForm.social_tiktok.value,',
'        telegram: contactForm.social_telegram.value,',
'        whatsappChannel: contactForm.social_whatsappChannel.value',
'      }',
'    }).then(function () { banner(contactForm, "تم حفظ بيانات التواصل."); }).catch(function (err) { banner(contactForm, err.message, "error"); });',
'  });',
'',
'  /* ---------------- الحساب ---------------- */',
'  var accountForm = $("#account-form");',
'  accountForm.addEventListener("submit", function (e) {',
'    e.preventDefault();',
'    postJson("/api/account", "PUT", {',
'      currentPassword: accountForm.currentPassword.value,',
'      username: accountForm.username.value,',
'      newPassword: accountForm.newPassword.value',
'    }).then(function (res) {',
'      banner(accountForm, "تم تحديث بيانات الحساب. استخدم اسم المستخدم وكلمة المرور الجديدين لاحقًا.");',
'      accountForm.reset();',
'      accountForm.username.value = res.username;',
'      $("#top-username").textContent = res.username;',
'    }).catch(function (err) { banner(accountForm, err.message, "error"); });',
'  });',
'',
'  /* ---------------- الرسائل ---------------- */',
'  function loadMessages() {',
'    request("/api/messages").then(function (res) {',
'      var body = $("#messages-body");',
'      body.innerHTML = "";',
'      (res.messages || []).forEach(function (m) {',
'        var tr = document.createElement("tr");',
'        var date = new Date(m.createdAt).toLocaleString("ar");',
'        tr.innerHTML = "";',
'        var cells = [m.name, m.phone || "-", m.email || "-", m.message, date];',
'        cells.forEach(function (c) { var td = document.createElement("td"); td.textContent = c; tr.appendChild(td); });',
'        var actionTd = document.createElement("td");',
'        var delBtn = document.createElement("button");',
'        delBtn.className = "mini-btn danger"; delBtn.textContent = "حذف";',
'        delBtn.addEventListener("click", function () {',
'          request("/api/messages/" + encodeURIComponent(m.id), { method: "DELETE" }).then(loadMessages);',
'        });',
'        actionTd.appendChild(delBtn);',
'        tr.appendChild(actionTd);',
'        body.appendChild(tr);',
'      });',
'      if (!(res.messages || []).length) { body.innerHTML = "<tr><td colspan=\\"6\\">لا توجد رسائل بعد.</td></tr>"; }',
'    });',
'  }',
'',
'  /* ---------------- إدارة عامة (أنشطة/معرض) ---------------- */',
'  function setupSimpleResource(opts) {',
'    var listEl = $("#" + opts.key + "-list");',
'    var form = $("#" + opts.key + "-form");',
'    var addBtn = $("#" + opts.key + "-add-btn");',
'    var cancelBtn = $("#" + opts.key + "-cancel-btn");',
'    var editingId = null;',
'',
'    function resetForm() {',
'      form.reset();',
'      editingId = null;',
'      form.dataset.image = "";',
'      $("#" + opts.key + "-image-preview").style.display = "none";',
'      form.style.display = "none";',
'    }',
'    addBtn.addEventListener("click", function () { resetForm(); form.style.display = "grid"; });',
'    cancelBtn.addEventListener("click", resetForm);',
'',
'    var imageInput = $("#" + opts.key + "-image-input");',
'    imageInput.addEventListener("change", function (e) {',
'      var f = e.target.files[0]; if (!f) return;',
'      uploadFile(f).then(function (url) {',
'        form.dataset.image = url;',
'        var prev = $("#" + opts.key + "-image-preview");',
'        prev.src = url; prev.style.display = "block";',
'      });',
'    });',
'',
'    form.addEventListener("submit", function (e) {',
'      e.preventDefault();',
'      var payload = opts.collect(form);',
'      var method = editingId ? "PUT" : "POST";',
'      var url = "/api/" + opts.key + (editingId ? "/" + encodeURIComponent(editingId) : "");',
'      postJson(url, method, payload).then(function () { resetForm(); refresh(); }).catch(function (err) { banner(form, err.message, "error"); });',
'    });',
'',
'    function refresh() {',
'      request("/api/" + opts.key + "?_=" + Date.now()).catch(function () { return null; });',
'      request("/api/content").then(function (data) {',
'        var items = data[opts.key] || [];',
'        listEl.innerHTML = "";',
'        items.forEach(function (item) {',
'          var row = document.createElement("div");',
'          row.className = "item-row";',
'          var img = document.createElement("img");',
'          img.src = item.image || "/assets/logo.svg";',
'          var info = document.createElement("div");',
'          info.className = "info";',
'          var strong = document.createElement("strong"); strong.textContent = opts.title(item);',
'          var span = document.createElement("span"); span.textContent = opts.subtitle(item);',
'          info.appendChild(strong); info.appendChild(span);',
'          var actions = document.createElement("div"); actions.className = "actions";',
'          var editBtn = document.createElement("button"); editBtn.className = "mini-btn"; editBtn.textContent = "تعديل";',
'          editBtn.addEventListener("click", function () {',
'            editingId = item.id;',
'            opts.fill(form, item);',
'            form.dataset.image = item.image || "";',
'            var prev = $("#" + opts.key + "-image-preview");',
'            prev.src = item.image || "/assets/logo.svg"; prev.style.display = "block";',
'            form.style.display = "grid";',
'          });',
'          var delBtn = document.createElement("button"); delBtn.className = "mini-btn danger"; delBtn.textContent = "حذف";',
'          delBtn.addEventListener("click", function () {',
'            if (!confirm("هل تريد حذف هذا العنصر؟")) return;',
'            request("/api/" + opts.key + "/" + encodeURIComponent(item.id), { method: "DELETE" }).then(refresh);',
'          });',
'          actions.appendChild(editBtn); actions.appendChild(delBtn);',
'          row.appendChild(img); row.appendChild(info); row.appendChild(actions);',
'          listEl.appendChild(row);',
'        });',
'        if (!items.length) listEl.innerHTML = "<p>لا توجد عناصر بعد.</p>";',
'      });',
'    }',
'    resetForm();',
'    return { refresh: refresh };',
'  }',
'',
'  var activitiesCtrl = setupSimpleResource({',
'    key: "activities",',
'    title: function (i) { return i.title; },',
'    subtitle: function (i) { return i.category + " · " + i.date; },',
'    collect: function (form) {',
'      return { title: form.title.value, details: form.details.value, date: form.date.value, category: form.category.value, image: form.dataset.image || "" };',
'    },',
'    fill: function (form, item) {',
'      form.title.value = item.title; form.details.value = item.details;',
'      form.date.value = item.date; form.category.value = item.category;',
'    }',
'  });',
'',
'  var galleryCtrl = setupSimpleResource({',
'    key: "gallery",',
'    title: function (i) { return i.title; },',
'    subtitle: function (i) { return i.caption || ""; },',
'    collect: function (form) { return { title: form.title.value, caption: form.caption.value, image: form.dataset.image || "" }; },',
'    fill: function (form, item) { form.title.value = item.title; form.caption.value = item.caption || ""; }',
'  });',
'',
'  /* ---------------- إدارة المراكز (صور وفيديوهات متعددة) ---------------- */',
'  var centersList = $("#centers-list");',
'  var centersForm = $("#centers-form");',
'  var centersAddBtn = $("#centers-add-btn");',
'  var centersCancelBtn = $("#centers-cancel-btn");',
'  var centerEditingId = null;',
'  var centerImages = [];',
'  var centerVideos = [];',
'',
'  function renderCenterThumbs() {',
'    var wrap = $("#centers-images-thumbs");',
'    wrap.innerHTML = "";',
'    centerImages.forEach(function (url, idx) {',
'      var thumb = document.createElement("div"); thumb.className = "thumb";',
'      var img = document.createElement("img"); img.src = url;',
'      var btn = document.createElement("button"); btn.textContent = "×";',
'      btn.addEventListener("click", function () { centerImages.splice(idx, 1); renderCenterThumbs(); });',
'      thumb.appendChild(img); thumb.appendChild(btn);',
'      wrap.appendChild(thumb);',
'    });',
'  }',
'  function renderCenterVideoChips() {',
'    var wrap = $("#centers-videos-chips");',
'    wrap.innerHTML = "";',
'    centerVideos.forEach(function (url, idx) {',
'      var chip = document.createElement("span"); chip.className = "chip";',
'      var label = document.createElement("span"); label.textContent = url.length > 34 ? url.slice(0, 34) + "…" : url;',
'      var btn = document.createElement("button"); btn.textContent = "×";',
'      btn.addEventListener("click", function () { centerVideos.splice(idx, 1); renderCenterVideoChips(); });',
'      chip.appendChild(label); chip.appendChild(btn);',
'      wrap.appendChild(chip);',
'    });',
'  }',
'  $("#centers-images-input").addEventListener("change", function (e) {',
'    var files = Array.prototype.slice.call(e.target.files);',
'    Promise.all(files.map(uploadFile)).then(function (urls) {',
'      centerImages = centerImages.concat(urls);',
'      renderCenterThumbs();',
'      e.target.value = "";',
'    }).catch(function (err) { banner(centersForm, err.message, "error"); });',
'  });',
'  $("#centers-video-add").addEventListener("click", function () {',
'    var input = $("#centers-video-input");',
'    var url = input.value.trim();',
'    if (!url) return;',
'    centerVideos.push(url);',
'    input.value = "";',
'    renderCenterVideoChips();',
'  });',
'',
'  function resetCentersForm() {',
'    centersForm.reset();',
'    centerEditingId = null;',
'    centerImages = []; centerVideos = [];',
'    renderCenterThumbs(); renderCenterVideoChips();',
'    centersForm.style.display = "none";',
'  }',
'  centersAddBtn.addEventListener("click", function () { resetCentersForm(); centersForm.style.display = "grid"; });',
'  centersCancelBtn.addEventListener("click", resetCentersForm);',
'',
'  centersForm.addEventListener("submit", function (e) {',
'    e.preventDefault();',
'    var payload = {',
'      name: centersForm.name.value,',
'      city: centersForm.city.value,',
'      details: centersForm.details.value,',
'      manager: centersForm.manager.value,',
'      hours: centersForm.hours.value,',
'      phone: centersForm.phone.value,',
'      images: centerImages,',
'      videos: centerVideos',
'    };',
'    var method = centerEditingId ? "PUT" : "POST";',
'    var url = "/api/centers" + (centerEditingId ? "/" + encodeURIComponent(centerEditingId) : "");',
'    postJson(url, method, payload).then(function () { resetCentersForm(); refreshCenters(); }).catch(function (err) { banner(centersForm, err.message, "error"); });',
'  });',
'',
'  function refreshCenters() {',
'    request("/api/content").then(function (data) {',
'      var items = data.centers || [];',
'      centersList.innerHTML = "";',
'      items.forEach(function (item) {',
'        var row = document.createElement("div"); row.className = "item-row";',
'        var img = document.createElement("img"); img.src = (item.images && item.images[0]) || "/assets/logo.svg";',
'        var info = document.createElement("div"); info.className = "info";',
'        var strong = document.createElement("strong"); strong.textContent = item.name;',
'        var span = document.createElement("span"); span.textContent = item.city + " · " + (item.images || []).length + " صورة · " + (item.videos || []).length + " فيديو";',
'        info.appendChild(strong); info.appendChild(span);',
'        var actions = document.createElement("div"); actions.className = "actions";',
'        var editBtn = document.createElement("button"); editBtn.className = "mini-btn"; editBtn.textContent = "تعديل";',
'        editBtn.addEventListener("click", function () {',
'          centerEditingId = item.id;',
'          centersForm.name.value = item.name; centersForm.city.value = item.city;',
'          centersForm.details.value = item.details; centersForm.manager.value = item.manager || "";',
'          centersForm.hours.value = item.hours || ""; centersForm.phone.value = item.phone || "";',
'          centerImages = (item.images || []).slice(); centerVideos = (item.videos || []).slice();',
'          renderCenterThumbs(); renderCenterVideoChips();',
'          centersForm.style.display = "grid";',
'        });',
'        var delBtn = document.createElement("button"); delBtn.className = "mini-btn danger"; delBtn.textContent = "حذف";',
'        delBtn.addEventListener("click", function () {',
'          if (!confirm("هل تريد حذف هذا المركز؟")) return;',
'          request("/api/centers/" + encodeURIComponent(item.id), { method: "DELETE" }).then(refreshCenters);',
'        });',
'        actions.appendChild(editBtn); actions.appendChild(delBtn);',
'        row.appendChild(img); row.appendChild(info); row.appendChild(actions);',
'        centersList.appendChild(row);',
'      });',
'      if (!items.length) centersList.innerHTML = "<p>لا توجد مراكز بعد.</p>";',
'    });',
'  }',
'  resetCentersForm();',
'',
'  /* ---------------- تحميل شامل ---------------- */',
'  function loadAll() {',
'    request("/api/content").then(function (data) {',
'      fillSettings(data.settings || {});',
'      fillContact(data.contact || {});',
'    });',
'    activitiesCtrl.refresh();',
'    galleryCtrl.refresh();',
'    refreshCenters();',
'    loadMessages();',
'  }',
'',
'  /* ---------------- تحقق الجلسة عند فتح الصفحة ---------------- */',
'  request("/api/session").then(function (res) {',
'    if (res.authenticated) { $("#top-username").textContent = res.username; showShell(); }',
'    else showLogin("");',
'  }).catch(function () { showLogin(""); });',
'})();'
].join('\n');

var ADMIN_HTML = [
'<!DOCTYPE html>',
'<html lang="ar" dir="rtl">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>لوحة الإدارة — مؤسسة ملتقى العلم والثقافية</title>',
'<meta name="robots" content="noindex">',
'<link rel="stylesheet" href="/styles.css">',
'<!--APP_BASE-->',
'</head>',
'<body>',
'<div id="admin-login" class="admin-login">',
'  <form class="login-card" id="login-form">',
'    <h1>لوحة الإدارة</h1>',
'    <p>سجّل الدخول لإدارة محتوى موقع مؤسسة ملتقى العلم والثقافية.</p>',
'    <div class="field"><label for="lu">اسم المستخدم</label><input id="lu" name="username" required autofocus></div>',
'    <div class="field"><label for="lp">كلمة المرور</label><input id="lp" name="password" type="password" required></div>',
'    <p id="login-error" style="color:#a33;font-size:.85rem;min-height:1.2em;"></p>',
'    <button class="btn btn-gold" type="submit" style="width:100%;">دخول</button>',
'  </form>',
'</div>',
'',
'<div id="admin-shell" class="admin-shell" style="display:none;">',
'  <div class="admin-top">',
'    <div class="wrap">',
'      <strong>لوحة إدارة الموقع</strong>',
'      <span>مرحبًا، <span id="top-username"></span> · <button id="logout-btn" class="mini-btn">تسجيل الخروج</button> · <a href="/" class="mini-btn" style="text-decoration:none;">عرض الموقع</a></span>',
'    </div>',
'  </div>',
'  <div class="admin-body">',
'    <nav class="admin-nav">',
'      <button data-panel="settings" class="active">الإعدادات العامة</button>',
'      <button data-panel="activities">الأنشطة</button>',
'      <button data-panel="centers">المراكز</button>',
'      <button data-panel="gallery">معرض الصور</button>',
'      <button data-panel="contact">التواصل والروابط</button>',
'      <button data-panel="messages">رسائل الزوار</button>',
'      <button data-panel="account">إعدادات الحساب</button>',
'    </nav>',
'    <div class="admin-main">',
'',
'      <section class="panel active" id="panel-settings">',
'        <h2>الإعدادات العامة</h2>',
'        <form id="settings-form" class="card-form">',
'          <div><label>اسم المؤسسة</label><input name="siteName" required></div>',
'          <div><label>العبارة المختصرة</label><input name="tagline" required></div>',
'          <div class="full"><label>عنوان الواجهة الرئيسية</label><input name="heroTitle" required></div>',
'          <div class="full"><label>نص الواجهة الرئيسية</label><textarea name="heroText" required></textarea></div>',
'          <div><label>الشعار (Logo)</label><div class="upload-box"><img id="settings-logo-preview" style="width:60px;height:60px;object-fit:cover;border-radius:8px;margin-bottom:8px;"><input type="file" id="settings-logo-input" accept="image/*"></div></div>',
'          <div><label>صورة الواجهة الرئيسية</label><div class="upload-box"><img id="settings-hero-preview" style="width:100%;max-width:220px;aspect-ratio:4/3;object-fit:cover;border-radius:8px;margin-bottom:8px;"><input type="file" id="settings-hero-input" accept="image/*"></div></div>',
'          <div class="form-actions"><button class="btn btn-gold" type="submit">حفظ الإعدادات</button></div>',
'        </form>',
'      </section>',
'',
'      <section class="panel" id="panel-activities">',
'        <h2>الأنشطة والبرامج</h2>',
'        <div class="toolbar"><span id="activities-list"></span><button class="mini-btn primary" id="activities-add-btn">+ إضافة نشاط</button></div>',
'        <form id="activities-form" class="card-form" style="display:none;margin-bottom:22px;">',
'          <div><label>عنوان النشاط</label><input name="title" required></div>',
'          <div><label>التصنيف</label><input name="category" required></div>',
'          <div><label>الموعد</label><input name="date" required></div>',
'          <div><label>صورة النشاط</label><div class="upload-box"><img id="activities-image-preview" style="width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;margin-bottom:8px;display:none;"><input type="file" id="activities-image-input" accept="image/*"></div></div>',
'          <div class="full"><label>وصف النشاط</label><textarea name="details" required></textarea></div>',
'          <div class="form-actions"><button class="btn btn-gold" type="submit">حفظ</button><button type="button" class="mini-btn" id="activities-cancel-btn">إلغاء</button></div>',
'        </form>',
'      </section>',
'',
'      <section class="panel" id="panel-centers">',
'        <h2>مراكز المؤسسة</h2>',
'        <div class="toolbar"><span id="centers-list"></span><button class="mini-btn primary" id="centers-add-btn">+ إضافة مركز</button></div>',
'        <form id="centers-form" class="card-form" style="display:none;margin-bottom:22px;">',
'          <div><label>اسم المركز</label><input name="name" required></div>',
'          <div><label>المدينة / الموقع</label><input name="city" required></div>',
'          <div><label>المسؤول</label><input name="manager"></div>',
'          <div><label>أوقات الدوام</label><input name="hours"></div>',
'          <div><label>الهاتف</label><input name="phone"></div>',
'          <div class="full"><label>وصف المركز</label><textarea name="details" required></textarea></div>',
'          <div class="full"><label>صور المركز (يمكن اختيار أكثر من صورة)</label><div class="upload-box"><input type="file" id="centers-images-input" accept="image/*" multiple></div><div class="thumb-grid" id="centers-images-thumbs"></div></div>',
'          <div class="full"><label>روابط فيديوهات المركز (يوتيوب أو أي رابط فيديو)</label><div style="display:flex;gap:8px;"><input type="url" id="centers-video-input" placeholder="https://..." style="flex:1;"><button type="button" class="mini-btn" id="centers-video-add">إضافة</button></div><div class="chip-list" id="centers-videos-chips"></div></div>',
'          <div class="form-actions"><button class="btn btn-gold" type="submit">حفظ المركز</button><button type="button" class="mini-btn" id="centers-cancel-btn">إلغاء</button></div>',
'        </form>',
'      </section>',
'',
'      <section class="panel" id="panel-gallery">',
'        <h2>معرض الصور</h2>',
'        <div class="toolbar"><span id="gallery-list"></span><button class="mini-btn primary" id="gallery-add-btn">+ إضافة صورة</button></div>',
'        <form id="gallery-form" class="card-form" style="display:none;margin-bottom:22px;">',
'          <div><label>عنوان الصورة</label><input name="title" required></div>',
'          <div><label>وصف مختصر</label><input name="caption"></div>',
'          <div class="full"><label>الصورة</label><div class="upload-box"><img id="gallery-image-preview" style="width:200px;aspect-ratio:16/10;object-fit:cover;border-radius:8px;margin-bottom:8px;display:none;"><input type="file" id="gallery-image-input" accept="image/*"></div></div>',
'          <div class="form-actions"><button class="btn btn-gold" type="submit">حفظ</button><button type="button" class="mini-btn" id="gallery-cancel-btn">إلغاء</button></div>',
'        </form>',
'      </section>',
'',
'      <section class="panel" id="panel-contact">',
'        <h2>التواصل وروابط التواصل الاجتماعي</h2>',
'        <form id="contact-form-admin" class="card-form">',
'          <div><label>العنوان</label><input name="address"></div>',
'          <div><label>الهاتف</label><input name="phone"></div>',
'          <div><label>واتساب</label><input name="whatsapp"></div>',
'          <div><label>البريد الإلكتروني</label><input name="email" type="email"></div>',
'          <div><label>أوقات الدوام</label><input name="workHours"></div>',
'          <div><label>رابط الخريطة (Google Maps)</label><input name="mapUrl" type="url" placeholder="https://maps.google.com/..."></div>',
'          <div class="full" style="border-top:1px solid var(--line);margin-top:6px;padding-top:14px;"><strong>روابط التواصل الاجتماعي</strong></div>',
'          <div><label>فيسبوك</label><input name="social_facebook" type="url" placeholder="https://facebook.com/..."></div>',
'          <div><label>إنستغرام</label><input name="social_instagram" type="url" placeholder="https://instagram.com/..."></div>',
'          <div><label>إكس (تويتر)</label><input name="social_x" type="url" placeholder="https://x.com/..."></div>',
'          <div><label>يوتيوب</label><input name="social_youtube" type="url" placeholder="https://youtube.com/..."></div>',
'          <div><label>تيك توك</label><input name="social_tiktok" type="url" placeholder="https://tiktok.com/..."></div>',
'          <div><label>تيليجرام</label><input name="social_telegram" type="url" placeholder="https://t.me/..."></div>',
'          <div><label>قناة واتساب</label><input name="social_whatsappChannel" type="url" placeholder="https://whatsapp.com/channel/..."></div>',
'          <div class="form-actions"><button class="btn btn-gold" type="submit">حفظ بيانات التواصل</button></div>',
'        </form>',
'      </section>',
'',
'      <section class="panel" id="panel-messages">',
'        <h2>رسائل الزوار</h2>',
'        <table class="table-simple">',
'          <thead><tr><th>الاسم</th><th>الهاتف</th><th>البريد</th><th>الرسالة</th><th>التاريخ</th><th></th></tr></thead>',
'          <tbody id="messages-body"></tbody>',
'        </table>',
'      </section>',
'',
'      <section class="panel" id="panel-account">',
'        <h2>إعدادات الحساب</h2>',
'        <p style="color:#6b6353;font-size:.9rem;">لتغيير اسم المستخدم أو كلمة المرور يجب إدخال كلمة المرور الحالية أولًا.</p>',
'        <form id="account-form" class="card-form">',
'          <div><label>كلمة المرور الحالية</label><input name="currentPassword" type="password" required></div>',
'          <div><label>اسم المستخدم الجديد</label><input name="username" required></div>',
'          <div><label>كلمة المرور الجديدة (8 أحرف على الأقل)</label><input name="newPassword" type="password" required minlength="8"></div>',
'          <div class="form-actions"><button class="btn btn-gold" type="submit">تحديث الحساب</button></div>',
'        </form>',
'      </section>',
'',
'    </div>',
'  </div>',
'</div>',
'<script src="/admin.js"></script>',
'</body>',
'</html>'
].join('\n');

async function ensurePublicFiles() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.mkdir(path.join(PUBLIC_DIR, 'assets'), { recursive: true });
  await fs.writeFile(path.join(PUBLIC_DIR, 'styles.css'), STYLES_CSS, 'utf8');
  await fs.writeFile(path.join(PUBLIC_DIR, 'app.js'), APP_JS, 'utf8');
  await fs.writeFile(path.join(PUBLIC_DIR, 'admin.js'), ADMIN_JS, 'utf8');
  await fs.writeFile(path.join(PUBLIC_DIR, 'index.html'), INDEX_HTML, 'utf8');
  await fs.writeFile(path.join(PUBLIC_DIR, 'admin.html'), ADMIN_HTML, 'utf8');
  // شعار افتراضي بسيط (SVG) يُستخدم فقط إلى أن يرفع المسؤول شعارًا حقيقيًا من لوحة الإدارة.
  const logoPath = path.join(PUBLIC_DIR, 'assets', 'logo.svg');
  try { await fs.access(logoPath); } catch {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">'
      + '<rect width="200" height="200" fill="#1f3b3b"/>'
      + '<text x="100" y="122" font-size="80" text-anchor="middle" fill="#c08a2e" font-family="Arial, sans-serif">ع</text>'
      + '</svg>';
    await fs.writeFile(logoPath, svg, 'utf8');
  }
}

/* ------------------------------------------------------------------ */
/* التشغيل                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  await ensureDataFiles();
  await ensurePublicFiles();
  await loadSessions();

  setInterval(function () {
    const now = Date.now();
    let changed = false;
    for (const entry of sessions) { if (entry[1].expiresAt < now) { sessions.delete(entry[0]); changed = true; } }
    if (changed || sessionsDirty) { sessionsDirty = false; persistSessions(); }
  }, 15 * 60 * 1000).unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
      let pathname = decodeURIComponent(url.pathname);
      if (BASE_PATH && pathname.startsWith(BASE_PATH)) pathname = pathname.slice(BASE_PATH.length) || '/';
      if (pathname.startsWith('/api/')) {
        url.pathname = pathname;
        await handleApi(req, res, url);
      } else {
        await serveStatic(res, pathname);
      }
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendError(res, error.status || 500, error.message || 'حدث خطأ غير متوقع.');
      else res.end();
    }
  });
  server.listen(PORT, () => {
    console.log('ملتقى العلم والثقافية يعمل على http://localhost:' + PORT + (BASE_PATH || ''));
    console.log('لوحة الإدارة: http://localhost:' + PORT + (BASE_PATH || '') + '/admin');
  });
}

main().catch((error) => { console.error(error); process.exit(1); });
