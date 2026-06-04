import 'dotenv/config'
import { randomUUID, webcrypto } from 'node:crypto'
import { createServer } from 'node:http'
import { basename, extname } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import P from 'pino'
import Busboy from 'busboy'
import QRCode from 'qrcode'
import terminalQrcode from 'qrcode-terminal'

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto
}

const BOT_NAME = process.env.BOT_NAME || 'Mi Bot'
const DEFAULT_REPLY =
  process.env.DEFAULT_REPLY ||
  'Si queres, escribime hola y te comparto las opciones disponibles 😊'
const TIMEZONE = process.env.TIMEZONE || 'UTC'
const OWNER_JID = process.env.OWNER_JID || ''
const AUTH_DIR = process.env.AUTH_DIR || 'auth'
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3000)
const BROADCAST_CONTACTS = (process.env.ALLOWED_BROADCAST || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const GOOGLE_CALENDAR_CLIENT_EMAIL = process.env.GOOGLE_CALENDAR_CLIENT_EMAIL || ''
const GOOGLE_CALENDAR_PRIVATE_KEY = (process.env.GOOGLE_CALENDAR_PRIVATE_KEY || '').replace(/\\n/g, '\n')
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || ''
const GOOGLE_CALENDAR_TIMEZONE = process.env.GOOGLE_CALENDAR_TIMEZONE || process.env.TIMEZONE || 'UTC'
const GOOGLE_CALENDAR_WORK_START = process.env.GOOGLE_CALENDAR_WORK_START || '09:00'
const GOOGLE_CALENDAR_WORK_END = process.env.GOOGLE_CALENDAR_WORK_END || '18:00'
const GOOGLE_CALENDAR_SLOT_MINUTES = Number(process.env.GOOGLE_CALENDAR_SLOT_MINUTES || 60)
const GOOGLE_CALENDAR_DAYS_AHEAD = Number(process.env.GOOGLE_CALENDAR_DAYS_AHEAD || 7)
const CONVERSATIONS_DIR = new URL('../data/', import.meta.url)
const CONVERSATIONS_FILE = new URL('../data/conversations.json', import.meta.url)
const CONFLICT_RULES_FILE = new URL('../data/conflict-rules.json', import.meta.url)
const MESSAGES_FILE = new URL('../data/messages.json', import.meta.url)
const UPLOADS_DIR = new URL('../data/uploads/', import.meta.url)
const ADMIN_PAGE_FILE = new URL('../public/admin.html', import.meta.url)
const CALENDAR_PAGE_FILE = new URL('../public/calendar.html', import.meta.url)
const LINK_PAGE_FILE = new URL('../public/link.html', import.meta.url)
const DOCUMENTATION_PAGE_FILE = new URL('../public/documentation.html', import.meta.url)
const CONFIG_PAGE_FILE = new URL('../public/config.html', import.meta.url)
const CONVERSATION_STATUSES = new Set(['pendiente', 'respondida', 'urgente'])
const PAYMENT_RECEIPT_STATUSES = new Set(['', 'requested', 'received', 'verified'])
const MESSAGE_SOURCES = new Set(['contact', 'bot', 'human'])
const HUMAN_PAUSE_MS = 24 * 60 * 60 * 1000
const AUTO_REPLY_DEDUP_MS = 2 * 60 * 1000
const OWN_MESSAGE_ID_TTL_MS = 10 * 60 * 1000
const SCHEDULING_SELECTION_TEXTS = new Set(['1', '2', '3'])
const TURN_BOOKING_STAGES = new Set(['', 'awaiting-insurance', 'awaiting-name-after-coverage', 'awaiting-objective'])
const COVERED_INSURANCE_NAMES = [
  'amffa',
  'avalian',
  'aca salud',
  'damsu',
  'jerarquicos salud',
  'medicus',
  'swiss medical',
  'iosfa',
  'omint',
  'osseg',
  'galeno',
  'sancor salud',
  'federada salud',
  'andes salud',
  'nobis',
  'red de seguro medico',
  'prevencion salud',
  'tv salud',
  'luz y fuerza',
  'ospatca',
  'ospe',
  'ospida',
  'ospip',
  'ospis',
  'poder judicial',
  'policia federal',
  'luis pasteur',
  'higea salud',
  'brindar salud',
  'bramed',
  'leal medica'
]
const COORDINATING_TOPICS = new Set([
  'turnos',
  'consulta-nutricional',
  'nutricion-deportiva',
  'antropometria',
  'antropometria-vs-inbody',
  'antropometria-plan',
  'neurologia',
  'valores',
  'ubicacion',
  'diabetes',
  'descenso-peso',
  'reserva-turno'
])
const BOOKING_ENTRY_TOPICS = new Set([
  'turnos',
  'consulta-nutricional',
  'nutricion-deportiva',
  'antropometria',
  'antropometria-vs-inbody',
  'antropometria-plan',
  'neurologia',
  'valores',
  'ubicacion',
  'diabetes',
  'descenso-peso'
])
const DEFAULT_TAGS = []
const CONFLICT_LEVELS = new Set(['leve', 'agresion', 'amenaza'])
const DEFAULT_CONFLICT_RULES = {
  amenaza: {
    reason: 'Amenaza de denuncia o acusacion',
    phrases: [
      'te voy a denunciar',
      'lo voy a denunciar',
      'te voy a acusar',
      'los voy a denunciar',
      'los voy a acusar'
    ]
  },
  agresion: {
    reason: 'Mensaje agresivo o descalificante',
    phrases: [
      'me esta tratando de boludo',
      'me está tratando de boludo',
      'una mierda',
      'pelotudo',
      'forro',
      'concha',
      'no me rompas'
    ]
  },
  leve: {
    reason: 'Lenguaje inapropiado o groseria',
    phrases: [
      'puto',
      'pito',
      'mierda',
      'boludo'
    ]
  }
}
const TOPIC_VALUES = new Set([
  'turnos',
  'obras-sociales',
  'obra-social-con-cobertura',
  'obra-social-no-cubierta',
  'consulta-nutricional',
  'nutricion-deportiva',
  'antropometria',
  'antropometria-vs-inbody',
  'antropometria-plan',
  'neurologia',
  'valores',
  'ubicacion',
  'hablar-con-celia',
  'reserva-turno',
  'politica-inasistencia',
  'diabetes',
  'descenso-peso',
  'human'
])

const INTENT_DISPATCH = {
  'turnos': { messageKey: 'turnos', topic: 'turnos' },
  'obras-sociales': { messageKey: 'obrasSociales', topic: 'obras-sociales' },
  'consulta-nutricional': { messageKey: 'consultaNutricional', topic: 'consulta-nutricional' },
  'nutricion-deportiva': { messageKey: 'nutricionDeportiva', topic: 'nutricion-deportiva' },
  'antropometria': { messageKey: 'antropometria', topic: 'antropometria' },
  'antropometria-vs-inbody': { messageKey: 'antropometriaVsInbody', topic: 'antropometria-vs-inbody' },
  'antropometria-plan': { messageKey: 'antropometriaPlan', topic: 'antropometria-plan' },
  'neurologia': { messageKey: 'neurologia', topic: 'neurologia' },
  'valores': { messageKey: 'valores', topic: 'valores' },
  'ubicacion': { messageKey: 'ubicacion', topic: 'ubicacion' },
  'reserva-turno': { messageKey: 'reservaTurno', topic: 'reserva-turno', requestsReceipt: true },
  'politica-inasistencia': { messageKey: 'politicaInasistencia', topic: 'politica-inasistencia' },
  'diabetes': { messageKey: 'diabetes', topic: 'diabetes' },
  'descenso-peso': { messageKey: 'descensoPeso', topic: 'descenso-peso' }
}

const DEFAULT_BOT_MESSAGES = {
  menu: [
    '¡Hola!',
    '',
    'Gracias por comunicarte con Lic. Celia Soler, Nutricionista.',
    '',
    '📍 Atención presencial en Clínica El Castaño – Consultorios externos (San Luis y Estados Unidos, San Juan).',
    '',
    '📅 Si querés reservar un turno, podés hacerlo directamente desde el siguiente enlace:',
    '',
    '🔗 https://licsoler.site.agendapro.com/ar',
    '',
    'Si necesitás ayuda, elegí una opción:',
    '',
    '1️⃣ Consultar cobertura de obra social',
    '2️⃣ Hablar con Celia',
    '',
    'Te responderemos a la brevedad 😊'
  ].join('\n'),
  defaultReply: DEFAULT_REPLY,
  intents: {
    turnos: [
      'Para coordinar un turno necesito que me indiques:',
      '',
      '👉 Nombre y apellido',
      '👉 Si tenés obra social y cuál',
      '',
      'Una vez recibida la información, te voy a pedir el objetivo de la consulta para seguir con la coordinación.'
    ].join('\n'),
    obrasSociales: [
      'Perfecto',
      '',
      'Por favor, escribí el nombre de tu obra social y te confirmaré si tiene cobertura.',
      '',
      'Si trabajamos con ella, también te informaré la documentación necesaria para gestionar la autorización.'
    ].join('\n'),
    obraSocialConCobertura: [
      '✅ Trabajamos con esa obra social.',
      '',
      'Valores:',
      '* Consulta o control: $15.000',
      '* Primera consulta + plan alimentario: $30.000',
      '',
      'Para la atención necesitaremos:',
      '👉 DNI',
      '👉 Número de afiliado/a',
      '👉 Token (si corresponde)',
      '',
      '📅 Podés reservar tu turno aquí:',
      '',
      '🔗 https://licsoler.site.agendapro.com/ar'
    ].join('\n'),
    obraSocialNoCubierta: [
      'Actualmente no trabajo con esa obra social.',
      '',
      'De todas formas, podés atenderte de manera particular:',
      '',
      '* Consulta o control: $30.000',
      '* Primera consulta + plan alimentario: $60.000',
      '',
      '📅 Reservá tu turno aquí:',
      '',
      '🔗 https://licsoler.site.agendapro.com/ar'
    ].join('\n'),
    consultaNutricional: [
      'La consulta incluye:',
      '',
      '✔️ Evaluación nutricional completa',
      '✔️ Revisión de hábitos alimentarios',
      '✔️ Análisis de objetivos y antecedentes',
      '✔️ Plan alimentario personalizado (en primera consulta)',
      '✔️ Educación alimentaria y estrategias prácticas',
      '',
      'Cada plan se adapta a las necesidades y objetivos de cada paciente.',
      '',
      '¿Querés coordinar tu consulta? Decime qué disponibilidad horaria tenés y te comparto los horarios disponibles 😊'
    ].join('\n'),
    nutricionDeportiva: [
      'Trabajo con deportistas de distintos niveles y disciplinas.',
      '',
      'El acompañamiento incluye:',
      '',
      '✔️ Evaluación nutricional',
      '✔️ Estrategias para mejorar rendimiento',
      '✔️ Alimentación adaptada a entrenamientos y competencias',
      '✔️ Recuperación y composición corporal',
      '',
      'También puede complementarse con antropometría de 5 componentes.',
      '',
      '¿Querés coordinar tu turno? Decime qué disponibilidad horaria tenés y te comparto los horarios disponibles 😊'
    ].join('\n'),
    antropometria: [
      'La antropometría de 5 componentes es una evaluación completa de la composición corporal.',
      '',
      'Permite conocer:',
      '',
      '✔️ Masa grasa',
      '✔️ Masa muscular',
      '✔️ Masa ósea',
      '✔️ Masa residual',
      '✔️ Masa de la piel',
      '',
      'Incluye medición y explicación de los resultados.',
      '',
      '💰 Valor: $45.000',
      '📍 Atención presencial.',
      '',
      '¿Querés coordinar la antropometría? Decime qué disponibilidad horaria tenés y te comparto los horarios disponibles 😊'
    ].join('\n'),
    antropometriaVsInbody: [
      'Sí, ambas evalúan composición corporal.',
      '',
      'La antropometría utiliza mediciones estandarizadas de pliegues y perímetros corporales, permitiendo un análisis detallado y seguimiento preciso de la composición corporal.',
      '',
      'Si querés coordinarla, decime qué disponibilidad horaria tenés y te paso los horarios disponibles 😊'
    ].join('\n'),
    antropometriaPlan: [
      'La antropometría incluye la evaluación y explicación de los resultados.',
      '',
      'Si además necesitás un plan alimentario personalizado, corresponde realizar una consulta nutricional.',
      '',
      '¿Te ayudamos a coordinar la consulta? Decime qué disponibilidad horaria tenés 😊'
    ].join('\n'),
    neurologia: [
      'Perfecto 😊',
      '',
      'Podemos coordinar tu turno.',
      '',
      '📍 Atención presencial en Clínica El Castaño – Consultorios externos (San Luis y Estados Unidos, San Juan).',
      '',
      'Para confirmar la reserva del horario se solicita una seña de $15.000 mediante transferencia.',
      '',
      'Una vez enviada la seña, el turno queda confirmado.',
      '',
      'Decime qué disponibilidad horaria tenés y te comparto los horarios disponibles 😊'
    ].join('\n'),
    valores: [
      '💰 Valores actuales:',
      '',
      '• Consulta o control:',
      '  $30.000 particular',
      '  $15.000 con obra social',
      '',
      '• Primera consulta + plan alimentario:',
      '  $60.000 particular',
      '  $30.000 con obra social',
      '',
      '• Antropometría de 5 componentes:',
      '  $45.000 (solo particular)',
      '',
      '¿Querés coordinar tu turno? Decime qué disponibilidad horaria tenés y te comparto los horarios disponibles 😊'
    ].join('\n'),
    ubicacion: [
      '📍 Clínica El Castaño – Consultorios externos',
      '',
      'San Luis y Estados Unidos',
      'San Juan, Argentina',
      '',
      'Atención exclusivamente presencial.',
      '',
      '¿Querés coordinar tu turno? Decime qué disponibilidad horaria tenés y te comparto los horarios disponibles 😊'
    ].join('\n'),
    hablarConCelia: [
      '¡Perfecto! 😊',
      '',
      'Dejame tu consulta o contame brevemente cuál es tu objetivo, y Celia te responderá a la brevedad.',
      '',
      'Quedo atenta.'
    ].join('\n'),
    reservaTurno: [
      'Para confirmar el turno se solicita una seña de $15.000 mediante transferencia.',
      '',
      'ALIAS: cefsoler',
      'Titular: Celia Fatima Soler',
      '',
      'Una vez realizado el pago, enviá el comprobante y el turno quedará confirmado 💚'
    ].join('\n'),
    politicaInasistencia: [
      'Si necesitás reprogramar, avisá con anticipación y coordinaremos un nuevo horario.',
      '',
      'Las inasistencias sin aviso previo generan la pérdida de la seña abonada.'
    ].join('\n'),
    diabetes: [
      'La alimentación cumple un papel fundamental en el control glucémico.',
      '',
      'En consulta se trabaja de manera personalizada, teniendo en cuenta tratamiento, medicación, hábitos y objetivos.',
      '',
      '¿Querés coordinar tu consulta? Decime qué disponibilidad horaria tenés y te comparto los horarios disponibles 😊'
    ].join('\n'),
    descensoPeso: [
      'El objetivo es lograr un descenso de peso saludable y sostenible.',
      '',
      'La consulta permite identificar hábitos, obstáculos y estrategias para construir un plan adaptado a tu realidad.',
      '',
      '¿Querés coordinar tu consulta? Decime qué disponibilidad horaria tenés y te comparto los horarios disponibles 😊'
    ].join('\n')
  },
  humanHandoff: [
    'Gracias por escribirnos 😊',
    '',
    'Ya dejamos asentado que queres hablar con una persona del equipo.',
    'Apenas estemos disponibles, te respondemos por este mismo medio.',
    '',
    'Gracias por tu paciencia 💚'
  ].join('\n'),
  topicFollowups: {
    waitingHumanFirstOffer: [
      'Si querés, mientras esperás atención humana, también podemos seguir desde el menú 😊',
      'Te comparto nuevamente las opciones disponibles.'
    ].join('\n'),
    waitingHumanRepeat: 'Si necesitás algo más, podés elegir una opción del menú o dejarnos tu consulta y la revisamos 😊',
    generic: 'Recibimos tu mensaje 😊 Lo dejamos asentado y te respondemos a la brevedad por este medio 💚',
    coordinandoTurno: [
      '¡Genial! 😊 Verifico la disponibilidad de agenda y te confirmo el horario en un ratito.',
      '',
      'Si querés ir agilizando la reserva, podés enviarnos el comprobante de la seña ($15.000 por transferencia al alias *cefsoler* – Celia Fatima Soler).',
      '',
      'Una vez verificado el pago, el turno queda confirmado 💚'
    ].join('\n'),
    bookingAfterCoverage: [
      'Para coordinar un turno necesito que me indiques:',
      '',
      '👉 Nombre y apellido',
      '',
      'Una vez recibida la información, te voy a pedir el objetivo de la consulta para seguir con la coordinación.'
    ].join('\n'),
    insuranceCoverageConfirmed: [
      'Perfecto 😊',
      '',
      'Con esos datos, a la brevedad nos estaremos contactando.',
      '',
      'Si preferís, también podés reservar tu turno directamente acá:',
      '',
      '🔗 https://licsoler.site.agendapro.com/ar'
    ].join('\n'),
    comprobanteRecibido: '¡Recibimos el comprobante! 🙌 Verificamos el pago y te confirmamos el turno en breve.'
  },
  commands: {
    help: [
      'Soy {{botName}} 🤖.',
      '',
      'Podes escribirme hola, menu o turno para ver las opciones disponibles.'
    ].join('\n'),
    time: 'Hora actual: {{time}} ({{timezone}})',
    about: '{{botName}} esta funcionando con Node.js + Baileys.',
    ping: 'pong 🏓',
    broadcastForbidden: 'No tienes permiso para usar !broadcast.',
    broadcastNoContacts: 'No hay contactos configurados para broadcast en ALLOWED_BROADCAST.',
    broadcastMessage: 'Mensaje de prueba enviado por {{botName}} 😊',
    broadcastDone: 'Broadcast enviado a {{count}} contacto(s).'
  },
  quickReplies: [
    {
      id: 'human-follow-up',
      label: 'Seguimiento humano',
      text: 'Gracias por tu mensaje 😊 Un integrante del equipo va a continuar la atencion por este medio apenas este disponible. Gracias por tu paciencia 💚'
    },
    {
      id: 'request-details',
      label: 'Pedir datos',
      text: 'Gracias 😊 Para poder ayudarte mejor, por favor envianos nombre y apellido junto con el detalle de tu consulta. Apenas lo recibamos, te respondemos por este medio 💚'
    },
    {
      id: 'confirm-received',
      label: 'Confirmar recepcion',
      text: 'Recibimos tu mensaje 😊 Ya lo dejamos asentado y te respondemos a la brevedad por este medio 💚'
    }
  ]
}

const GREETING_TEXTS = new Set([
  'hola',
  'buen dia',
  'buenos dias',
  'buenas',
  'buenas tardes',
  'buenas noches',
  'hello',
  'hi',
  'hey',
  'ey',
  'ola'
])

const greetedContacts = new Set()
const conversations = new Map()

let adminServerStarted = false
let persistConversationsPromise = Promise.resolve()
let conflictRules = DEFAULT_CONFLICT_RULES
let botMessages = DEFAULT_BOT_MESSAGES
const ownMessageIds = new Map()
let linkState = {
  connected: false,
  status: 'starting',
  qrDataUrl: '',
  updatedAt: null
}

function getTextFromMessage(message) {
  if (!message) return ''

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  )
}

function getCurrentTime() {
  return new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: TIMEZONE
  }).format(new Date())
}

function getContactName(msg) {
  return msg?.pushName?.trim() || ''
}

function personalizeText(name, text, options = {}) {
  if (!name || options.includeGreeting === false) return text

  return `Hola ${name},\n\n${text}`
}

function getMenuText(name) {
  return personalizeText(name, botMessages.menu, { includeGreeting: false })
}

function getIsoTimestamp() {
  return new Date().toISOString()
}

function isConversationChat(jid) {
  return Boolean(jid) && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast') && !jid.endsWith('@status')
}

function getConversationPreview(text) {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function getMediaTypeFromMime(mimetype = '') {
  if (mimetype.startsWith('image/')) return 'image'
  if (mimetype.startsWith('audio/')) return 'audio'
  if (mimetype.startsWith('video/')) return 'video'
  return 'document'
}

function getAttachmentSummary(messageType, fileName) {
  switch (messageType) {
    case 'image':
      return fileName ? `[Imagen] ${fileName}` : '[Imagen]'
    case 'audio':
      return fileName ? `[Audio] ${fileName}` : '[Audio]'
    case 'video':
      return fileName ? `[Video] ${fileName}` : '[Video]'
    case 'document':
      return fileName ? `[Documento] ${fileName}` : '[Documento]'
    default:
      return fileName || ''
  }
}

function getMessageMetadata(message) {
  if (message?.imageMessage) {
    return {
      messageType: 'image',
      mimeType: message.imageMessage.mimetype || '',
      fileName: message.imageMessage.fileName || ''
    }
  }

  if (message?.audioMessage) {
    return {
      messageType: 'audio',
      mimeType: message.audioMessage.mimetype || '',
      fileName: message.audioMessage.fileName || ''
    }
  }

  if (message?.videoMessage) {
    return {
      messageType: 'video',
      mimeType: message.videoMessage.mimetype || '',
      fileName: message.videoMessage.fileName || ''
    }
  }

  if (message?.documentMessage) {
    return {
      messageType: 'document',
      mimeType: message.documentMessage.mimetype || '',
      fileName: message.documentMessage.fileName || ''
    }
  }

  return {
    messageType: 'text',
    mimeType: '',
    fileName: ''
  }
}

function sanitizeUploadFileName(fileName = 'archivo') {
  const baseName = basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'archivo'
  return `${randomUUID()}-${baseName}`
}

function getUploadUrl(fileName) {
  return `/uploads/${encodeURIComponent(fileName)}`
}

function getUploadFileUrl(fileName) {
  return new URL(`../data/uploads/${fileName}`, import.meta.url)
}

async function ensureUploadsDir() {
  await mkdir(UPLOADS_DIR, { recursive: true })
}

function getMimeTypeFromFileName(fileName = '') {
  const extension = extname(fileName).toLowerCase()
  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}


function normalizeConversationStatus(status) {
  return CONVERSATION_STATUSES.has(status) ? status : 'pendiente'
}

function normalizePaymentReceiptStatus(status) {
  return PAYMENT_RECEIPT_STATUSES.has(status) ? status : ''
}

function normalizeTurnBookingStage(stage) {
  return TURN_BOOKING_STAGES.has(stage) ? stage : ''
}

function normalizeMessageSource(source, fallbackDirection = 'in') {
  if (MESSAGE_SOURCES.has(source)) return source
  return fallbackDirection === 'out' ? 'bot' : 'contact'
}

function normalizeHumanPauseUntil(value) {
  if (typeof value !== 'string' || !value) return ''
  return Number.isNaN(Date.parse(value)) ? '' : value
}

function getHumanPauseUntilDate(baseDate = new Date()) {
  return new Date(baseDate.getTime() + HUMAN_PAUSE_MS).toISOString()
}

function isHumanPauseActive(conversation, now = Date.now()) {
  if (!conversation?.humanPauseEnabled) return false
  if (!conversation.humanPauseUntil) return false
  const pauseUntil = Date.parse(conversation.humanPauseUntil)
  return Number.isFinite(pauseUntil) && pauseUntil > now
}

function hasRecentBotText(conversation, text, windowMs = AUTO_REPLY_DEDUP_MS, now = Date.now()) {
  if (!conversation || !text) return false

  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index]
    if (message?.source !== 'bot' || message?.direction !== 'out') continue

    const sentAt = Date.parse(message.timestamp || '')
    if (!Number.isFinite(sentAt)) return false
    if (now - sentAt > windowMs) return false

    return message.text === text
  }

  return false
}

function isSocketActive(sock) {
  return Boolean(sock) && activeSocket === sock
}

function pruneOwnMessageIds(now = Date.now()) {
  for (const [messageId, timestamp] of ownMessageIds.entries()) {
    if (now - timestamp > OWN_MESSAGE_ID_TTL_MS) {
      ownMessageIds.delete(messageId)
    }
  }
}

function rememberOwnMessageId(messageId) {
  if (!messageId) return
  pruneOwnMessageIds()
  ownMessageIds.set(messageId, Date.now())
}

function isOwnAppMessage(messageId) {
  if (!messageId) return false
  pruneOwnMessageIds()
  return ownMessageIds.has(messageId)
}

function normalizeCalendarSlot(slot, fallbackIndex = 0) {
  if (!slot || typeof slot !== 'object') return null
  const start = typeof slot.start === 'string' ? slot.start : ''
  const end = typeof slot.end === 'string' ? slot.end : ''
  if (!start || !end) return null
  const id = typeof slot.id === 'string' && slot.id.trim() ? slot.id.trim() : String(fallbackIndex + 1)
  return { id, start, end }
}

function normalizeCalendarSlots(slots) {
  if (!Array.isArray(slots)) return []
  return slots
    .map((slot, index) => normalizeCalendarSlot(slot, index))
    .filter(Boolean)
    .slice(0, 6)
}

function createConversationRecord(jid, now = getIsoTimestamp()) {
  return {
    jid,
    name: '',
    firstMessageAt: now,
    lastMessageAt: now,
    lastMessageText: '',
    messageCount: 0,
    unreadCount: 0,
    lastIncomingAt: null,
    lastOutgoingAt: null,
    status: 'pendiente',
    notes: '',
    tags: [...DEFAULT_TAGS],
    currentTopic: '',
    waitingForHuman: false,
    humanFallbackOffered: false,
    escalationReason: '',
    conflictLevel: '',
    paymentReceiptStatus: '',
    turnBookingStage: '',
    offeredCalendarSlots: [],
    selectedCalendarSlotStart: '',
    selectedCalendarSlotEnd: '',
    calendarEventId: '',
    humanPauseEnabled: true,
    humanPauseUntil: '',
    shouldUseNameGreeting: true,
    messages: []
  }
}

function getConversation(jid) {
  return conversations.get(jid)
}

function normalizeConversationTopic(topic) {
  return TOPIC_VALUES.has(topic) ? topic : ''
}

function normalizeConflictLevel(level) {
  return CONFLICT_LEVELS.has(level) ? level : ''
}

function normalizeConflictRules(rawRules) {
  const normalized = {}

  for (const level of CONFLICT_LEVELS) {
    const source = rawRules?.[level] || DEFAULT_CONFLICT_RULES[level]
    normalized[level] = {
      reason: source?.reason || DEFAULT_CONFLICT_RULES[level].reason,
      phrases: Array.isArray(source?.phrases) && source.phrases.length > 0
        ? source.phrases.map((phrase) => `${phrase}`.trim()).filter(Boolean)
        : DEFAULT_CONFLICT_RULES[level].phrases
    }
  }

  return normalized
}

function includesAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase))
}

function detectConflictLevel(text) {
  if (includesAny(text, conflictRules.amenaza.phrases)) {
    return {
      level: 'amenaza',
      reason: conflictRules.amenaza.reason
    }
  }

  if (includesAny(text, conflictRules.agresion.phrases)) {
    return {
      level: 'agresion',
      reason: conflictRules.agresion.reason
    }
  }

  if (includesAny(text, conflictRules.leve.phrases)) {
    return {
      level: 'leve',
      reason: conflictRules.leve.reason
    }
  }

  return null
}

function isOperatorRequest(text) {
  return includesAny(text, [
    'hablar con celia',
    'hablar con la nutri',
    'hablar con la nutricionista',
    'quiero hablar con celia',
    'necesito hablar con celia',
    'operador',
    'agente',
    'asesor',
    'una persona',
    'humano',
    'alguien',
    'atencion humana',
    'hablar con alguien',
    'hablar con un operador',
    'hablar con un agente'
  ])
}

function detectIntent(text) {
  if (isOperatorRequest(text)) return 'hablar-con-celia'

  if (text === '1' || includesAny(text, ['obras sociales', 'obra social', 'cobertura', 'prepaga', 'afiliado', 'afiliada', 'me cubre', 'me toman'])) return 'obras-sociales'
  if (text === '2') return 'hablar-con-celia'
  if (includesAny(text, ['sacar turno', 'quiero un turno', 'quiero turno', 'reservar turno', 'agendar turno', 'pedir turno', 'turno por favor'])) return 'turnos'
  if (includesAny(text, ['consulta nutricional', 'que incluye la consulta', 'que incluye consulta', 'plan alimentario', 'plan de comidas', 'que evaluas'])) return 'consulta-nutricional'
  if (includesAny(text, ['nutricion deportiva', 'deportista', 'deportiva', 'crossfit', 'rendimiento deportivo', 'rendimiento', 'entrenamiento', 'entrenando', 'gimnasio', 'corro', 'running', 'futbol', 'rugby'])) return 'nutricion-deportiva'
  if (includesAny(text, ['antropometria', 'antropometria de 5 componentes', '5 componentes', 'composicion corporal', 'medicion corporal'])) return 'antropometria'
  if (includesAny(text, ['neurologia', 'neurologico', 'neurologica', 'epilepsia', 'parkinson', 'alzheimer', 'esclerosis'])) return 'neurologia'
  if (includesAny(text, ['valores', 'valor', 'precio', 'precios', 'cuanto cuesta', 'cuanto sale', 'cuanto vale', 'costo', 'aranceles'])) return 'valores'
  if (includesAny(text, ['ubicacion', 'donde atendes', 'donde queda', 'donde estas', 'direccion', 'consultorio', 'como llegar', 'google maps', 'maps', 'mapa', 'clinica el castano'])) return 'ubicacion'

  if (includesAny(text, ['inbody', 'in body', 'bioimpedancia'])) return 'antropometria-vs-inbody'
  if (includesAny(text, ['antropometria me da plan', 'antropometria incluye plan', 'antropometria con plan', 'me das plan', 'incluye plan'])) return 'antropometria-plan'
  if (includesAny(text, ['como confirmo el turno', 'como reservo', 'como confirmo', 'sena', 'seña', 'alias', 'transferencia', 'pago del turno'])) return 'reserva-turno'
  if (includesAny(text, ['no puedo asistir', 'no podre asistir', 'no podre ir', 'no voy a poder', 'inasistencia', 'reprogramar', 'que pasa si no'])) return 'politica-inasistencia'
  if (includesAny(text, ['diabetes', 'diabetico', 'diabetica', 'glucemia', 'insulina', 'azucar alta'])) return 'diabetes'
  if (includesAny(text, ['bajar de peso', 'descenso de peso', 'perder peso', 'adelgazar', 'quiero adelgazar', 'bajar peso'])) return 'descenso-peso'

  return ''
}

function shouldTreatAsTopicMessage(text) {
  return text.length >= 4
}

async function ensureConversationStore() {
  await mkdir(CONVERSATIONS_DIR, { recursive: true })

  try {
    const raw = await readFile(CONVERSATIONS_FILE, 'utf8')
    const items = JSON.parse(raw)

    if (!Array.isArray(items)) return

    for (const item of items) {
      if (!item?.jid) continue
      conversations.set(item.jid, {
        jid: item.jid,
        name: item.name || '',
        firstMessageAt: item.firstMessageAt || null,
        lastMessageAt: item.lastMessageAt || null,
        lastMessageText: item.lastMessageText || '',
        unreadCount: Number.isFinite(item.unreadCount) ? item.unreadCount : 0,
        lastIncomingAt: item.lastIncomingAt || null,
        lastOutgoingAt: item.lastOutgoingAt || null,
        status: normalizeConversationStatus(item.status),
        notes: item.notes || '',
        tags: Array.isArray(item.tags) ? item.tags.filter(Boolean) : [...DEFAULT_TAGS],
        currentTopic: normalizeConversationTopic(item.currentTopic),
        waitingForHuman: Boolean(item.waitingForHuman),
        humanFallbackOffered: Boolean(item.humanFallbackOffered),
        escalationReason: item.escalationReason || '',
        conflictLevel: normalizeConflictLevel(item.conflictLevel),
        paymentReceiptStatus: normalizePaymentReceiptStatus(item.paymentReceiptStatus),
        turnBookingStage: normalizeTurnBookingStage(item.turnBookingStage),
        offeredCalendarSlots: normalizeCalendarSlots(item.offeredCalendarSlots),
        selectedCalendarSlotStart: typeof item.selectedCalendarSlotStart === 'string' ? item.selectedCalendarSlotStart : '',
        selectedCalendarSlotEnd: typeof item.selectedCalendarSlotEnd === 'string' ? item.selectedCalendarSlotEnd : '',
        calendarEventId: typeof item.calendarEventId === 'string' ? item.calendarEventId : '',
        humanPauseEnabled: item.humanPauseEnabled !== false,
        humanPauseUntil: normalizeHumanPauseUntil(item.humanPauseUntil),
        shouldUseNameGreeting: item.shouldUseNameGreeting !== false,
        messageCount: Array.isArray(item.messages) ? item.messages.length : 0,
        messages: Array.isArray(item.messages)
          ? item.messages.map((message) => ({
            direction: message?.direction === 'out' ? 'out' : 'in',
            source: normalizeMessageSource(message?.source, message?.direction),
            text: typeof message?.text === 'string' ? message.text : '',
            timestamp: typeof message?.timestamp === 'string' ? message.timestamp : now,
            messageType: typeof message?.messageType === 'string' ? message.messageType : 'text',
            mediaUrl: typeof message?.mediaUrl === 'string' ? message.mediaUrl : '',
            mimeType: typeof message?.mimeType === 'string' ? message.mimeType : '',
            fileName: typeof message?.fileName === 'string' ? message.fileName : ''
          }))
          : []
      })
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('No se pudieron cargar las conversaciones:', error)
    }
  }
}

async function ensureConflictRules() {
  await mkdir(CONVERSATIONS_DIR, { recursive: true })

  try {
    const raw = await readFile(CONFLICT_RULES_FILE, 'utf8')
    conflictRules = normalizeConflictRules(JSON.parse(raw))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await writeFile(CONFLICT_RULES_FILE, `${JSON.stringify(DEFAULT_CONFLICT_RULES, null, 2)}\n`)
      conflictRules = normalizeConflictRules(DEFAULT_CONFLICT_RULES)
      return
    }

    console.error('No se pudieron cargar las reglas de conflicto:', error)
    conflictRules = normalizeConflictRules(DEFAULT_CONFLICT_RULES)
  }
}

async function updateConflictRules(rawRules) {
  conflictRules = normalizeConflictRules(rawRules)
  await writeFile(CONFLICT_RULES_FILE, `${JSON.stringify(conflictRules, null, 2)}\n`)
  return conflictRules
}

function applyTemplate(text, vars = {}) {
  return Object.entries(vars).reduce((acc, [key, value]) => {
    return acc.split(`{{${key}}}`).join(String(value))
  }, `${text ?? ''}`)
}

function normalizeQuickReply(reply, fallbackIndex = 0) {
  if (!reply || typeof reply !== 'object') return null
  const id = typeof reply.id === 'string' && reply.id.trim()
    ? reply.id.trim()
    : `respuesta-${fallbackIndex + 1}`
  const label = typeof reply.label === 'string' ? reply.label.trim() : ''
  const text = typeof reply.text === 'string' ? reply.text : ''
  if (!label || !text) return null
  return { id, label, text }
}

function pickString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function normalizeBotMessages(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {}
  const intents = safe.intents && typeof safe.intents === 'object' ? safe.intents : {}
  const topicFollowups = safe.topicFollowups && typeof safe.topicFollowups === 'object' ? safe.topicFollowups : {}
  const commands = safe.commands && typeof safe.commands === 'object' ? safe.commands : {}

  const seenIds = new Set()
  const quickReplies = (Array.isArray(safe.quickReplies) ? safe.quickReplies : DEFAULT_BOT_MESSAGES.quickReplies)
    .map((reply, index) => normalizeQuickReply(reply, index))
    .filter(Boolean)
    .map((reply) => {
      let candidate = reply.id
      let suffix = 1
      while (seenIds.has(candidate)) {
        suffix += 1
        candidate = `${reply.id}-${suffix}`
      }
      seenIds.add(candidate)
      return { ...reply, id: candidate }
    })

  return {
    menu: pickString(safe.menu, DEFAULT_BOT_MESSAGES.menu),
    defaultReply: pickString(safe.defaultReply, DEFAULT_BOT_MESSAGES.defaultReply),
    intents: {
      turnos: pickString(intents.turnos, DEFAULT_BOT_MESSAGES.intents.turnos),
      obrasSociales: pickString(intents.obrasSociales, DEFAULT_BOT_MESSAGES.intents.obrasSociales),
      obraSocialConCobertura: pickString(intents.obraSocialConCobertura, DEFAULT_BOT_MESSAGES.intents.obraSocialConCobertura),
      obraSocialNoCubierta: pickString(intents.obraSocialNoCubierta, DEFAULT_BOT_MESSAGES.intents.obraSocialNoCubierta),
      consultaNutricional: pickString(intents.consultaNutricional, DEFAULT_BOT_MESSAGES.intents.consultaNutricional),
      nutricionDeportiva: pickString(intents.nutricionDeportiva, DEFAULT_BOT_MESSAGES.intents.nutricionDeportiva),
      antropometria: pickString(intents.antropometria, DEFAULT_BOT_MESSAGES.intents.antropometria),
      antropometriaVsInbody: pickString(intents.antropometriaVsInbody, DEFAULT_BOT_MESSAGES.intents.antropometriaVsInbody),
      antropometriaPlan: pickString(intents.antropometriaPlan, DEFAULT_BOT_MESSAGES.intents.antropometriaPlan),
      neurologia: pickString(intents.neurologia, DEFAULT_BOT_MESSAGES.intents.neurologia),
      valores: pickString(intents.valores, DEFAULT_BOT_MESSAGES.intents.valores),
      ubicacion: pickString(intents.ubicacion, DEFAULT_BOT_MESSAGES.intents.ubicacion),
      hablarConCelia: pickString(intents.hablarConCelia, DEFAULT_BOT_MESSAGES.intents.hablarConCelia),
      reservaTurno: pickString(intents.reservaTurno, DEFAULT_BOT_MESSAGES.intents.reservaTurno),
      politicaInasistencia: pickString(intents.politicaInasistencia, DEFAULT_BOT_MESSAGES.intents.politicaInasistencia),
      diabetes: pickString(intents.diabetes, DEFAULT_BOT_MESSAGES.intents.diabetes),
      descensoPeso: pickString(intents.descensoPeso, DEFAULT_BOT_MESSAGES.intents.descensoPeso)
    },
    humanHandoff: pickString(safe.humanHandoff, DEFAULT_BOT_MESSAGES.humanHandoff),
    topicFollowups: {
      waitingHumanFirstOffer: pickString(topicFollowups.waitingHumanFirstOffer, DEFAULT_BOT_MESSAGES.topicFollowups.waitingHumanFirstOffer),
      waitingHumanRepeat: pickString(topicFollowups.waitingHumanRepeat, DEFAULT_BOT_MESSAGES.topicFollowups.waitingHumanRepeat),
      generic: pickString(topicFollowups.generic, DEFAULT_BOT_MESSAGES.topicFollowups.generic),
      coordinandoTurno: pickString(topicFollowups.coordinandoTurno, DEFAULT_BOT_MESSAGES.topicFollowups.coordinandoTurno),
      bookingAfterCoverage: pickString(topicFollowups.bookingAfterCoverage, DEFAULT_BOT_MESSAGES.topicFollowups.bookingAfterCoverage),
      insuranceCoverageConfirmed: pickString(topicFollowups.insuranceCoverageConfirmed, DEFAULT_BOT_MESSAGES.topicFollowups.insuranceCoverageConfirmed),
      comprobanteRecibido: pickString(topicFollowups.comprobanteRecibido, DEFAULT_BOT_MESSAGES.topicFollowups.comprobanteRecibido)
    },
    commands: {
      help: pickString(commands.help, DEFAULT_BOT_MESSAGES.commands.help),
      time: pickString(commands.time, DEFAULT_BOT_MESSAGES.commands.time),
      about: pickString(commands.about, DEFAULT_BOT_MESSAGES.commands.about),
      ping: pickString(commands.ping, DEFAULT_BOT_MESSAGES.commands.ping),
      broadcastForbidden: pickString(commands.broadcastForbidden, DEFAULT_BOT_MESSAGES.commands.broadcastForbidden),
      broadcastNoContacts: pickString(commands.broadcastNoContacts, DEFAULT_BOT_MESSAGES.commands.broadcastNoContacts),
      broadcastMessage: pickString(commands.broadcastMessage, DEFAULT_BOT_MESSAGES.commands.broadcastMessage),
      broadcastDone: pickString(commands.broadcastDone, DEFAULT_BOT_MESSAGES.commands.broadcastDone)
    },
    quickReplies: quickReplies.length > 0 ? quickReplies : [...DEFAULT_BOT_MESSAGES.quickReplies]
  }
}

async function ensureBotMessages() {
  await mkdir(CONVERSATIONS_DIR, { recursive: true })

  try {
    const raw = await readFile(MESSAGES_FILE, 'utf8')
    botMessages = normalizeBotMessages(JSON.parse(raw))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      botMessages = normalizeBotMessages(DEFAULT_BOT_MESSAGES)
      await writeFile(MESSAGES_FILE, `${JSON.stringify(botMessages, null, 2)}\n`)
      return
    }

    console.error('No se pudieron cargar los mensajes del bot:', error)
    botMessages = normalizeBotMessages(DEFAULT_BOT_MESSAGES)
  }
}

async function updateBotMessages(rawMessages) {
  botMessages = normalizeBotMessages(rawMessages)
  await writeFile(MESSAGES_FILE, `${JSON.stringify(botMessages, null, 2)}\n`)
  return botMessages
}

function serializeConversations() {
  return [...conversations.values()]
    .sort((left, right) => (right.lastMessageAt || '').localeCompare(left.lastMessageAt || ''))
}

function persistConversations() {
  const payload = JSON.stringify(serializeConversations(), null, 2)

  persistConversationsPromise = persistConversationsPromise
    .then(() => writeFile(CONVERSATIONS_FILE, payload))
    .catch((error) => {
      console.error('No se pudieron guardar las conversaciones:', error)
    })

  return persistConversationsPromise
}

async function recordConversationMessage({ jid, name, text = '', direction, source, messageType = 'text', mediaUrl = '', mimeType = '', fileName = '' }) {
  if (!isConversationChat(jid) || (!text && !mediaUrl && !fileName)) return

  const now = getIsoTimestamp()
  const current = conversations.get(jid) || createConversationRecord(jid, now)
  const effectiveText = text || getAttachmentSummary(messageType, fileName)

  current.name = name || current.name || ''
  current.firstMessageAt = current.firstMessageAt || now
  current.lastMessageAt = now
  current.lastMessageText = effectiveText

  if (direction === 'in' && current.status === 'respondida') {
    current.status = 'pendiente'
  }

  if (direction === 'in') {
    current.unreadCount += 1
    current.lastIncomingAt = now
  }

  if (direction === 'out') {
    current.lastOutgoingAt = now
  }

  current.messages.push({
    direction,
    source: normalizeMessageSource(source, direction),
    text,
    timestamp: now,
    messageType,
    mediaUrl,
    mimeType,
    fileName
  })

  current.messageCount = current.messages.length
  conversations.set(jid, current)

  await persistConversations()
}

function createConversationSummary(conversation) {
  return {
    jid: conversation.jid,
    name: conversation.name,
    firstMessageAt: conversation.firstMessageAt,
    lastMessageAt: conversation.lastMessageAt,
    lastMessageText: getConversationPreview(conversation.lastMessageText),
    messageCount: conversation.messageCount,
    unreadCount: conversation.unreadCount,
    lastIncomingAt: conversation.lastIncomingAt,
    lastOutgoingAt: conversation.lastOutgoingAt,
    status: conversation.status,
    notes: conversation.notes,
    tags: conversation.tags,
    currentTopic: conversation.currentTopic,
    waitingForHuman: conversation.waitingForHuman,
    humanFallbackOffered: conversation.humanFallbackOffered,
    escalationReason: conversation.escalationReason,
    conflictLevel: conversation.conflictLevel,
    paymentReceiptStatus: conversation.paymentReceiptStatus || '',
    turnBookingStage: conversation.turnBookingStage || '',
    offeredCalendarSlots: normalizeCalendarSlots(conversation.offeredCalendarSlots),
    selectedCalendarSlotStart: conversation.selectedCalendarSlotStart || '',
    selectedCalendarSlotEnd: conversation.selectedCalendarSlotEnd || '',
    calendarEventId: conversation.calendarEventId || '',
    humanPauseEnabled: conversation.humanPauseEnabled !== false,
    humanPauseUntil: conversation.humanPauseUntil || '',
    humanPauseActive: isHumanPauseActive(conversation)
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''

    req.on('data', (chunk) => {
      data += chunk
    })

    req.on('end', () => {
      resolve(data)
    })

    req.on('error', reject)
  })
}

async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers })
    const fields = {}
    let fileBuffer = Buffer.alloc(0)
    let upload = null

    busboy.on('field', (name, value) => {
      fields[name] = value
    })

    busboy.on('file', (name, file, info) => {
      const chunks = []
      upload = {
        fieldName: name,
        fileName: info.filename || 'archivo',
        mimeType: info.mimeType || 'application/octet-stream'
      }

      file.on('data', (chunk) => chunks.push(chunk))
      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks)
      })
    })

    busboy.on('finish', () => resolve({ fields, upload, fileBuffer }))
    busboy.on('error', reject)
    req.pipe(busboy)
  })
}

async function sendUploadedMediaReply(jid, { fileBuffer, fileName, mimeType, caption = '' }) {
  if (!activeSocket) {
    const error = new Error('WhatsApp no esta conectado')
    error.statusCode = 503
    throw error
  }

  if (!fileBuffer?.length) {
    const error = new Error('El archivo no puede estar vacio')
    error.statusCode = 400
    throw error
  }

  await ensureUploadsDir()

  const storedFileName = sanitizeUploadFileName(fileName)
  const uploadFileUrl = getUploadFileUrl(storedFileName)
  await writeFile(uploadFileUrl, fileBuffer)

  const messageType = getMediaTypeFromMime(mimeType)
  const mediaUrl = getUploadUrl(storedFileName)
  const payload = {}

  if (messageType === 'image') {
    payload.image = fileBuffer
    if (caption.trim()) payload.caption = caption.trim()
  } else if (messageType === 'audio') {
    payload.audio = fileBuffer
    payload.mimetype = mimeType
    payload.ptt = false
  } else if (messageType === 'video') {
    payload.video = fileBuffer
    if (caption.trim()) payload.caption = caption.trim()
  } else {
    payload.document = fileBuffer
    payload.mimetype = mimeType
    payload.fileName = fileName
  }

  const sentMessage = await activeSocket.sendMessage(jid, payload)
  rememberOwnMessageId(sentMessage?.key?.id)

  const conversation = getConversation(jid)
  await recordConversationMessage({
    jid,
    name: conversation?.name || '',
    text: caption.trim(),
    direction: 'out',
    source: 'human',
    messageType,
    mediaUrl,
    mimeType,
    fileName
  })

  await updateConversationMetadata(jid, {
    status: 'respondida',
    unreadCount: 0,
    waitingForHuman: false,
    escalationReason: '',
    conflictLevel: '',
    humanPauseUntil: conversation?.humanPauseEnabled === false ? '' : getHumanPauseUntilDate(),
    shouldUseNameGreeting: false
  })

  return getConversation(jid)
}

async function updateConversationMetadata(jid, updates) {
  const current = getConversation(jid)

  if (!current) {
    return null
  }

  if (typeof updates.status === 'string') {
    current.status = normalizeConversationStatus(updates.status)
  }

  if (typeof updates.notes === 'string') {
    current.notes = updates.notes.trim()
  }

  if (typeof updates.unreadCount === 'number' && updates.unreadCount >= 0) {
    current.unreadCount = updates.unreadCount
  }

  if (typeof updates.currentTopic === 'string') {
    current.currentTopic = normalizeConversationTopic(updates.currentTopic)
  }

  if (typeof updates.waitingForHuman === 'boolean') {
    current.waitingForHuman = updates.waitingForHuman
  }

  if (typeof updates.humanFallbackOffered === 'boolean') {
    current.humanFallbackOffered = updates.humanFallbackOffered
  }

  if (typeof updates.escalationReason === 'string') {
    current.escalationReason = updates.escalationReason.trim()
  }

  if (typeof updates.conflictLevel === 'string') {
    current.conflictLevel = normalizeConflictLevel(updates.conflictLevel)
  }

  if (typeof updates.paymentReceiptStatus === 'string') {
    current.paymentReceiptStatus = normalizePaymentReceiptStatus(updates.paymentReceiptStatus)
  }

  if (typeof updates.turnBookingStage === 'string') {
    current.turnBookingStage = normalizeTurnBookingStage(updates.turnBookingStage)
  }

  if (Array.isArray(updates.offeredCalendarSlots)) {
    current.offeredCalendarSlots = normalizeCalendarSlots(updates.offeredCalendarSlots)
  }

  if (typeof updates.selectedCalendarSlotStart === 'string') {
    current.selectedCalendarSlotStart = updates.selectedCalendarSlotStart.trim()
  }

  if (typeof updates.selectedCalendarSlotEnd === 'string') {
    current.selectedCalendarSlotEnd = updates.selectedCalendarSlotEnd.trim()
  }

  if (typeof updates.calendarEventId === 'string') {
    current.calendarEventId = updates.calendarEventId.trim()
  }

  if (typeof updates.humanPauseEnabled === 'boolean') {
    current.humanPauseEnabled = updates.humanPauseEnabled
    if (!updates.humanPauseEnabled) {
      current.humanPauseUntil = ''
    }
  }

  if (typeof updates.humanPauseUntil === 'string') {
    current.humanPauseUntil = normalizeHumanPauseUntil(updates.humanPauseUntil)
  }

  if (typeof updates.shouldUseNameGreeting === 'boolean') {
    current.shouldUseNameGreeting = updates.shouldUseNameGreeting
  }

  if (Array.isArray(updates.tags)) {
    current.tags = updates.tags
      .map((tag) => `${tag}`.trim())
      .filter(Boolean)
      .slice(0, 10)
  }

  conversations.set(jid, current)
  await persistConversations()
  return current
}

async function removeConversation(jid) {
  if (!conversations.has(jid)) return false

  conversations.delete(jid)
  greetedContacts.delete(jid)
  await persistConversations()
  return true
}

async function sendManualReply(jid, text) {
  if (!activeSocket) {
    const error = new Error('WhatsApp no esta conectado')
    error.statusCode = 503
    throw error
  }

  const conversation = getConversation(jid)
  const finalText = text.trim()

  if (!finalText) {
    const error = new Error('El mensaje no puede estar vacio')
    error.statusCode = 400
    throw error
  }

  const sentMessage = await activeSocket.sendMessage(jid, { text: finalText })
  rememberOwnMessageId(sentMessage?.key?.id)
  await recordConversationMessage({
    jid,
    name: conversation?.name || '',
    text: finalText,
    direction: 'out',
    source: 'human'
  })

  await updateConversationMetadata(jid, {
    status: 'respondida',
    unreadCount: 0,
    waitingForHuman: false,
    escalationReason: '',
    conflictLevel: '',
    humanPauseUntil: conversation?.humanPauseEnabled === false ? '' : getHumanPauseUntilDate(),
    shouldUseNameGreeting: false
  })

  return getConversation(jid)
}

async function maybeCreateCalendarEventAfterVerification(jid) {
  const result = await createCalendarEventForConversation(jid)
  if (!result.ok) return result

  if (activeSocket) {
    const conversation = getConversation(jid)
    if (conversation) {
      await sendText(activeSocket, jid, `Pago verificado y turno confirmado para ${formatSlotDateTime(conversation.selectedCalendarSlotStart)} 💚`, conversation.name || '', { includeGreeting: false })
    }
  }

  return result
}

async function applyConversationMetadataUpdate(jid, updates) {
  const existingConversation = getConversation(jid)
  const previous = existingConversation ? structuredClone(existingConversation) : null
  const conversation = await updateConversationMetadata(jid, updates)
  if (!conversation) return null

  const paymentChangedToVerified = previous?.paymentReceiptStatus !== 'verified' && conversation.paymentReceiptStatus === 'verified'
  if (paymentChangedToVerified) {
    const result = await maybeCreateCalendarEventAfterVerification(jid)
    if (result.reason === 'slot_unavailable' && activeSocket) {
      await sendText(activeSocket, jid, 'El horario que habias elegido ya no esta disponible. Te comparto nuevas opciones para que elijas otro turno.', conversation.name || '', { includeGreeting: false })
      await sendAvailableCalendarSlots(activeSocket, jid, conversation.name || '')
    }
  }

  return getConversation(jid)
}

async function confirmConversationTurn(jid) {
  const conversation = getConversation(jid)
  if (!conversation) {
    const error = new Error('Conversation not found')
    error.statusCode = 404
    throw error
  }

  if (!hasSelectedCalendarSlot(conversation)) {
    const error = new Error('Primero el contacto tiene que elegir un horario para poder confirmarlo.')
    error.statusCode = 400
    throw error
  }

  if (!isCalendarConfigured()) {
    const error = new Error('Google Calendar no esta configurado. Completa GOOGLE_CALENDAR_CLIENT_EMAIL, GOOGLE_CALENDAR_PRIVATE_KEY y GOOGLE_CALENDAR_ID en .env.')
    error.statusCode = 400
    throw error
  }

  if (conversation.calendarEventId) {
    const updatedConversation = await updateConversationMetadata(jid, {
      paymentReceiptStatus: 'verified',
      status: 'respondida',
      unreadCount: 0,
      waitingForHuman: false,
      escalationReason: '',
      conflictLevel: ''
    })
    return {
      conversation: updatedConversation,
      eventAction: 'already_confirmed',
      message: 'El turno ya estaba confirmado y agendado.'
    }
  }

  await updateConversationMetadata(jid, {
    paymentReceiptStatus: 'verified',
    status: 'respondida',
    unreadCount: 0,
    waitingForHuman: false,
    escalationReason: '',
    conflictLevel: ''
  })

  const result = await maybeCreateCalendarEventAfterVerification(jid)
  if (!result.ok) {
    const reasonMessages = {
      slot_unavailable: 'El horario elegido ya no esta disponible. Pedile al contacto que elija otro turno.',
      auth_failed: 'No se pudo autenticar con Google Calendar. Revisa las credenciales y permisos.',
      not_configured: 'Google Calendar no esta configurado correctamente.',
      not_ready: 'No se pudo confirmar el turno con la informacion actual.',
      calendar_not_found: result.errorMessage || 'Google Calendar no encontro el calendario configurado.',
      calendar_error: result.errorMessage || 'No se pudo crear el evento en Google Calendar.'
    }
    const error = new Error(reasonMessages[result.reason] || 'No se pudo crear el evento en Google Calendar.')
    error.statusCode = 400
    throw error
  }

  const updatedConversation = await updateConversationMetadata(jid, {
    status: 'respondida',
    unreadCount: 0,
    waitingForHuman: false,
    escalationReason: '',
    conflictLevel: ''
  })

  return {
    conversation: updatedConversation,
    eventAction: 'created',
    message: 'Turno confirmado, mensaje enviado y evento agendado en Google Calendar.'
  }
}

let googleCalendarClient = null
let googleCalendarClientPromise = null

function isCalendarConfigured() {
  return Boolean(GOOGLE_CALENDAR_CLIENT_EMAIL && GOOGLE_CALENDAR_PRIVATE_KEY && GOOGLE_CALENDAR_ID)
}

async function getCalendarClient() {
  if (googleCalendarClient) return googleCalendarClient
  if (!isCalendarConfigured()) return null
  if (googleCalendarClientPromise) return googleCalendarClientPromise

  googleCalendarClientPromise = (async () => {
    try {
      const { google } = await import('googleapis')
      const auth = new google.auth.JWT({
        email: GOOGLE_CALENDAR_CLIENT_EMAIL,
        key: GOOGLE_CALENDAR_PRIVATE_KEY,
        scopes: ['https://www.googleapis.com/auth/calendar']
      })
      await auth.authorize()
      googleCalendarClient = google.calendar({ version: 'v3', auth })
      return googleCalendarClient
    } catch (error) {
      console.error('No se pudo inicializar Google Calendar:', error.message)
      googleCalendarClientPromise = null
      return null
    }
  })()

  return googleCalendarClientPromise
}

function parseHourMinutes(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '')
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) return fallback
  return { hour, minute }
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  }
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - date.getTime()
}

function zonedDateTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const offset = getTimeZoneOffsetMs(new Date(guess), timeZone)
  return new Date(guess - offset)
}

function addDaysToCalendarDate({ year, month, day }, daysToAdd) {
  const date = new Date(Date.UTC(year, month - 1, day + daysToAdd, 12, 0, 0))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  }
}

function isBusinessCalendarDate({ year, month, day }) {
  const weekday = new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay()
  return weekday >= 1 && weekday <= 5
}

function formatSlotDateTime(isoString) {
  return new Intl.DateTimeFormat('es-AR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: GOOGLE_CALENDAR_TIMEZONE
  }).format(new Date(isoString))
}

function getSlotOptionLabel(slot) {
  return formatSlotDateTime(slot.start)
}

function getTopicDisplayLabel(topic) {
  const labels = {
    'turnos': 'Turno nutricional',
    'consulta-nutricional': 'Consulta nutricional',
    'nutricion-deportiva': 'Nutricion deportiva',
    'antropometria': 'Antropometria',
    'antropometria-vs-inbody': 'Antropometria',
    'antropometria-plan': 'Consulta nutricional',
    'neurologia': 'Consulta de neurologia',
    'valores': 'Turno nutricional',
    'ubicacion': 'Turno nutricional',
    'diabetes': 'Consulta por diabetes',
    'descenso-peso': 'Consulta por descenso de peso',
    'reserva-turno': 'Reserva de turno'
  }
  return labels[topic] || 'Turno nutricional'
}

function hasSelectedCalendarSlot(conversation) {
  return Boolean(conversation?.selectedCalendarSlotStart && conversation?.selectedCalendarSlotEnd)
}

function isRescheduleRequest(text) {
  return includesAny(text, ['reprogramar', 'reprogramo', 'cambiar turno', 'cambiar horario', 'otro horario', 'otro turno'])
}

function isCancellationRequest(text) {
  return includesAny(text, ['cancelar turno', 'cancelar reserva', 'cancelar', 'no puedo asistir', 'no podre asistir', 'no podre ir', 'no voy a poder'])
}

function extractSchedulingChoice(text, offeredSlots) {
  if (!Array.isArray(offeredSlots) || offeredSlots.length === 0) return null
  if (SCHEDULING_SELECTION_TEXTS.has(text)) {
    return offeredSlots.find((slot) => slot.id === text) || null
  }
  return null
}

function buildCalendarOfferText(slots) {
  const optionsText = slots.map((slot) => `${slot.id}. ${getSlotOptionLabel(slot)}`).join('\n')
  return [
    'Estos son los proximos horarios disponibles:',
    '',
    optionsText,
    '',
    'Responde con 1, 2 o 3 para reservar una opcion. Si necesitas otro horario, decime y te comparto mas alternativas.'
  ].join('\n')
}

function extractInsuranceCandidate(text) {
  const rawParts = text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (rawParts.length >= 2) {
    return normalizeIncomingText(rawParts[rawParts.length - 1])
  }

  const words = normalizeIncomingText(text).split(' ').filter(Boolean)
  if (words.length === 1) return words[0]
  if (words.length < 2) return ''
  return words[words.length - 1]
}

function detectCoveredInsurance(text) {
  if (!text) return ''
  const candidate = extractInsuranceCandidate(text)
  const haystacks = [text, candidate].filter(Boolean)

  for (const haystack of haystacks) {
    for (const insuranceName of COVERED_INSURANCE_NAMES) {
      if (haystack.includes(insuranceName)) return insuranceName
    }
  }

  return ''
}

function hasParticularCoverage(text) {
  return includesAny(text, ['sin obra social', 'particular', 'no tengo obra social', 'ninguna obra social'])
}

function seemsToContainTurnRequestDetails(text) {
  return text.includes(',') || text.split(' ').length >= 4 || Boolean(hasParticularCoverage(text) || detectCoveredInsurance(text))
}

function seemsToContainObjective(text) {
  return shouldTreatAsTopicMessage(text)
}

function detectCoordinatingTopicFromObjective(text) {
  const intent = detectIntent(text)
  const dispatch = INTENT_DISPATCH[intent]
  if (dispatch && COORDINATING_TOPICS.has(dispatch.topic) && dispatch.topic !== 'reserva-turno') {
    return dispatch.topic
  }
  return 'turnos'
}

function shouldHandleBookingFlow(conversation) {
  return Boolean(
    conversation &&
    BOOKING_ENTRY_TOPICS.has(conversation.currentTopic) &&
    !conversation.offeredCalendarSlots?.length &&
    !hasSelectedCalendarSlot(conversation)
  )
}

function getInsuranceCoverageMessageKey(text) {
  if (detectCoveredInsurance(text)) return 'obraSocialConCobertura'
  if (hasParticularCoverage(text) || extractInsuranceCandidate(text)) return 'obraSocialNoCubierta'
  return ''
}

async function handleInsuranceCoverageFollowUp(sock, sender, text, name, conversation) {
  if (!conversation) return false
  if (!shouldTreatAsTopicMessage(text)) return false

  if (conversation.currentTopic === 'obra-social-con-cobertura') {
    await sendText(sock, sender, botMessages.topicFollowups.insuranceCoverageConfirmed, name, { includeGreeting: false })
    return true
  }

  if (conversation.currentTopic === 'obra-social-no-cubierta') {
    await sendText(sock, sender, botMessages.intents.obraSocialNoCubierta, name, { includeGreeting: false })
    return true
  }

  if (conversation.currentTopic !== 'obras-sociales') return false

  const coverageMessageKey = getInsuranceCoverageMessageKey(text)
  const nextTopic = coverageMessageKey === 'obraSocialConCobertura'
    ? 'obra-social-con-cobertura'
    : coverageMessageKey === 'obraSocialNoCubierta'
      ? 'obra-social-no-cubierta'
      : 'obras-sociales'
  await setConversationFlow(sender, { currentTopic: nextTopic, turnBookingStage: '' })
  await sendText(
    sock,
    sender,
    coverageMessageKey ? botMessages.intents[coverageMessageKey] : botMessages.intents.obrasSociales,
    name,
    { includeGreeting: false }
  )
  return true
}

async function startBookingFlowFromTopic(sock, sender, text, name, conversation) {
  if (!conversation || conversation.turnBookingStage) {
    return false
  }

  if (!shouldTreatAsTopicMessage(text)) {
    return false
  }

  if (conversation.currentTopic === 'obras-sociales') {
    const coverageMessageKey = getInsuranceCoverageMessageKey(text)
    if (!coverageMessageKey) {
      await sendText(sock, sender, botMessages.intents.obrasSociales, name, { includeGreeting: false })
      return true
    }

    await sendText(
      sock,
      sender,
      botMessages.intents[coverageMessageKey],
      name,
      { includeGreeting: false }
    )
    return true
  }

  await setConversationFlow(sender, {
    turnBookingStage: 'awaiting-insurance',
    paymentReceiptStatus: '',
    offeredCalendarSlots: [],
    selectedCalendarSlotStart: '',
    selectedCalendarSlotEnd: '',
    calendarEventId: ''
  })
  await sendText(sock, sender, botMessages.intents.turnos, name, { includeGreeting: false })
  return true
}

async function isCalendarSlotStillAvailable(start, end) {
  const client = await getCalendarClient()
  if (!client) return false
  const response = await client.freebusy.query({
    requestBody: {
      timeMin: start,
      timeMax: end,
      timeZone: GOOGLE_CALENDAR_TIMEZONE,
      items: [{ id: GOOGLE_CALENDAR_ID }]
    }
  })
  const busyRanges = response.data.calendars?.[GOOGLE_CALENDAR_ID]?.busy || []
  return busyRanges.length === 0
}

function buildCalendarEventPayload(conversation) {
  return {
    summary: `${getTopicDisplayLabel(conversation.currentTopic)} - ${conversation.name || conversation.jid}`,
    description: [
      `Contacto: ${conversation.name || 'Sin nombre'}`,
      `JID: ${conversation.jid}`,
      `Tema: ${conversation.currentTopic || 'sin tema'}`,
      conversation.notes ? `Notas: ${conversation.notes}` : ''
    ].filter(Boolean).join('\n'),
    start: {
      dateTime: conversation.selectedCalendarSlotStart,
      timeZone: GOOGLE_CALENDAR_TIMEZONE
    },
    end: {
      dateTime: conversation.selectedCalendarSlotEnd,
      timeZone: GOOGLE_CALENDAR_TIMEZONE
    }
  }
}

async function createCalendarEventForConversation(jid) {
  const conversation = getConversation(jid)
  if (!conversation || conversation.paymentReceiptStatus !== 'verified' || !hasSelectedCalendarSlot(conversation) || conversation.calendarEventId) {
    return { ok: false, reason: 'not_ready' }
  }

  if (!isCalendarConfigured()) {
    return { ok: false, reason: 'not_configured' }
  }

  const client = await getCalendarClient()
  if (!client) {
    return { ok: false, reason: 'auth_failed' }
  }

  try {
    const slotAvailable = await isCalendarSlotStillAvailable(conversation.selectedCalendarSlotStart, conversation.selectedCalendarSlotEnd)
    if (!slotAvailable) {
      await updateConversationMetadata(jid, {
        selectedCalendarSlotStart: '',
        selectedCalendarSlotEnd: '',
        offeredCalendarSlots: []
      })
      return { ok: false, reason: 'slot_unavailable' }
    }

    const response = await client.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: buildCalendarEventPayload(conversation)
    })

    await updateConversationMetadata(jid, {
      calendarEventId: response.data.id || '',
      offeredCalendarSlots: []
    })

    return { ok: true, eventId: response.data.id || '' }
  } catch (error) {
    console.error('No se pudo crear el evento en Google Calendar:', error)
    if (error?.code === 404) {
      return { ok: false, reason: 'calendar_not_found', errorMessage: 'Google Calendar devolvio 404. Revisa GOOGLE_CALENDAR_ID y que la Service Account tenga acceso al calendario correcto.' }
    }
    return { ok: false, reason: 'calendar_error', errorMessage: error?.message || 'Error desconocido creando el evento en Google Calendar.' }
  }
}

async function cancelCalendarEvent(conversation) {
  if (!conversation?.calendarEventId || !isCalendarConfigured()) return
  const client = await getCalendarClient()
  if (!client) return
  try {
    await client.events.delete({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: conversation.calendarEventId
    })
  } catch (error) {
    if (error?.code !== 404) {
      console.error('No se pudo cancelar el evento en Google Calendar:', error.message)
    }
  }
}

async function sendAvailableCalendarSlots(sock, sender, name, options = {}) {
  const availability = await getCalendarAvailability(options.daysAhead)
  if (!availability.configured) {
    return { sent: false, reason: 'not_configured' }
  }

  if (!availability.available) {
    await sendText(sock, sender, 'Estoy teniendo un problema para consultar la agenda en este momento. Si queres, dejame tu disponibilidad y te respondo apenas la verifique.', name, { includeGreeting: false })
    return { sent: false, reason: 'unavailable' }
  }

  const freeSlots = availability.slots.filter((slot) => !slot.busy).slice(0, 3)
  if (freeSlots.length === 0) {
    await sendText(sock, sender, 'Por ahora no veo horarios libres en los proximos dias. Si queres, decime que disponibilidad tenes y te comparto nuevas opciones en cuanto se liberen.', name, { includeGreeting: false })
    await updateConversationMetadata(sender, { offeredCalendarSlots: [] })
    return { sent: false, reason: 'empty' }
  }

  const offeredCalendarSlots = freeSlots.map((slot, index) => ({
    id: String(index + 1),
    start: slot.start,
    end: slot.end
  }))

  await updateConversationMetadata(sender, { offeredCalendarSlots })
  await sendText(sock, sender, buildCalendarOfferText(offeredCalendarSlots), name, { includeGreeting: false })
  return { sent: true, offeredCalendarSlots }
}

async function handleTurnosDetails(sock, sender, text, name) {
  const conversation = getConversation(sender)
  const stage = conversation?.turnBookingStage || 'awaiting-insurance'

  if (stage === 'awaiting-name-after-coverage') {
    if (!shouldTreatAsTopicMessage(text)) {
      await sendText(sock, sender, botMessages.topicFollowups.bookingAfterCoverage, name, { includeGreeting: false })
      return true
    }

    await setConversationFlow(sender, { turnBookingStage: 'awaiting-objective' })
    await sendText(sock, sender, 'Perfecto 😊 Ahora decime cuál es el objetivo de la consulta para seguir con la coordinación del turno.', name, { includeGreeting: false })
    return true
  }

  if (stage === 'awaiting-objective') {
    if (!seemsToContainObjective(text)) {
      await sendText(sock, sender, 'Contame brevemente el objetivo de la consulta para seguir con la coordinación.', name, { includeGreeting: false })
      return true
    }

    const nextTopic = detectCoordinatingTopicFromObjective(text)
    await setConversationFlow(sender, {
      currentTopic: nextTopic,
      turnBookingStage: ''
    })
    await sendAvailableCalendarSlots(sock, sender, name)
    return true
  }

  if (!seemsToContainTurnRequestDetails(text)) return false

  if (hasParticularCoverage(text) || detectCoveredInsurance(text)) {
    await setConversationFlow(sender, { turnBookingStage: 'awaiting-objective' })
    await sendText(sock, sender, 'Perfecto 😊 Ahora decime cuál es el objetivo de la consulta para seguir con la coordinación del turno.', name, { includeGreeting: false })
    return true
  }

  const insuranceCandidate = extractInsuranceCandidate(text)
  if (insuranceCandidate) {
    await sendText(sock, sender, botMessages.intents.obraSocialNoCubierta, name, { includeGreeting: false })
    await setConversationFlow(sender, { turnBookingStage: 'awaiting-insurance' })
    return true
  }

  await sendText(sock, sender, 'Para continuar, indicame tu nombre y apellido junto con la obra social que tenes, o decime si es particular.', name, { includeGreeting: false })
  return true
}

async function getCalendarAvailability(daysAhead = GOOGLE_CALENDAR_DAYS_AHEAD) {
  if (!isCalendarConfigured()) {
    return { configured: false, slots: [], setupHint: 'Configurar GOOGLE_CALENDAR_CLIENT_EMAIL, GOOGLE_CALENDAR_PRIVATE_KEY y GOOGLE_CALENDAR_ID en .env' }
  }

  const client = await getCalendarClient()
  if (!client) {
    return { configured: true, available: false, slots: [], error: 'No se pudo autenticar con Google Calendar (revisar credenciales y permisos del calendario)' }
  }

  const days = Math.min(Math.max(1, Number(daysAhead) || 1), 30)
  const now = new Date()
  const zonedToday = getTimeZoneParts(now, GOOGLE_CALENDAR_TIMEZONE)
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  try {
    const fbResponse = await client.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: GOOGLE_CALENDAR_TIMEZONE,
        items: [{ id: GOOGLE_CALENDAR_ID }]
      }
    })

    const busyRanges = (fbResponse.data.calendars?.[GOOGLE_CALENDAR_ID]?.busy || [])
      .map((range) => ({ start: new Date(range.start).getTime(), end: new Date(range.end).getTime() }))

    const workStart = parseHourMinutes(GOOGLE_CALENDAR_WORK_START, { hour: 9, minute: 0 })
    const workEnd = parseHourMinutes(GOOGLE_CALENDAR_WORK_END, { hour: 18, minute: 0 })
    const slotMs = Math.max(15, GOOGLE_CALENDAR_SLOT_MINUTES) * 60 * 1000
    const slots = []

    for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
      const calendarDate = addDaysToCalendarDate(zonedToday, dayOffset)
      if (!isBusinessCalendarDate(calendarDate)) continue

      const day = zonedDateTimeToUtc(
        calendarDate.year,
        calendarDate.month,
        calendarDate.day,
        workStart.hour,
        workStart.minute,
        GOOGLE_CALENDAR_TIMEZONE
      )
      const dayEnd = zonedDateTimeToUtc(
        calendarDate.year,
        calendarDate.month,
        calendarDate.day,
        workEnd.hour,
        workEnd.minute,
        GOOGLE_CALENDAR_TIMEZONE
      )

      for (let slotStart = day.getTime(); slotStart + slotMs <= dayEnd.getTime(); slotStart += slotMs) {
        const slotEnd = slotStart + slotMs
        if (slotStart < now.getTime()) continue

        const busy = busyRanges.some((range) => slotStart < range.end && slotEnd > range.start)
        slots.push({
          start: new Date(slotStart).toISOString(),
          end: new Date(slotEnd).toISOString(),
          busy
        })
      }
    }

    return {
      configured: true,
      available: true,
      timezone: GOOGLE_CALENDAR_TIMEZONE,
      slotMinutes: GOOGLE_CALENDAR_SLOT_MINUTES,
      workStart: GOOGLE_CALENDAR_WORK_START,
      workEnd: GOOGLE_CALENDAR_WORK_END,
      slots
    }
  } catch (error) {
    console.error('Error consultando Google Calendar:', error.message)
    return { configured: true, available: false, slots: [], error: error.message || 'Error consultando Google Calendar' }
  }
}

async function getCalendarOverview(daysAhead = GOOGLE_CALENDAR_DAYS_AHEAD) {
  const availability = await getCalendarAvailability(daysAhead)
  if (!availability.configured || !availability.available) {
    return availability
  }

  const client = await getCalendarClient()
  if (!client) {
    return { configured: true, available: false, slots: [], events: [], error: 'No se pudo autenticar con Google Calendar.' }
  }

  const days = Math.min(Math.max(1, Number(daysAhead) || 1), 30)
  const now = new Date()
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  try {
    const response = await client.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250
    })

    const events = (response.data.items || []).map((event) => ({
      id: event.id || '',
      summary: event.summary || 'Turno ocupado',
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || ''
    })).filter((event) => event.start && event.end)

    return {
      ...availability,
      events
    }
  } catch (error) {
    console.error('Error listando eventos de Google Calendar:', error.message)
    return {
      configured: true,
      available: false,
      slots: [],
      events: [],
      error: error?.message || 'Error listando eventos de Google Calendar.'
    }
  }
}

async function clearAuthDirectory() {
  await rm(AUTH_DIR, { recursive: true, force: true })
  await mkdir(AUTH_DIR, { recursive: true })
}

async function logoutWhatsappSession() {
  greetedContacts.clear()
  clearReconnectTimer()

  const sockRef = activeSocket

  if (sockRef) {
    try {
      await sockRef.logout()
    } catch (error) {
      console.error('No se pudo cerrar la sesion de WhatsApp limpiamente:', error)
    }

    try {
      sockRef.end?.(undefined)
    } catch (error) {
      console.error('No se pudo finalizar el socket de WhatsApp:', error)
    }
  }

  activeSocket = undefined

  await clearAuthDirectory()

  setLinkState({
    connected: false,
    status: 'logged_out',
    qrDataUrl: ''
  })

  scheduleReconnect()
}

function normalizeCsvText(value) {
  return String(value ?? '')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeCsvValue(value) {
  return `"${normalizeCsvText(value).replaceAll('"', '""')}"`
}

function buildConversationsCsv() {
  const rows = [
    [
      'jid',
      'nombre',
      'estado',
      'no_leidos',
      'esperando_humano',
      'tema_actual',
      'motivo_derivacion',
      'nivel_conflicto',
      'etiquetas',
      'primera_actividad',
      'ultima_actividad',
      'ultima_entrada',
      'ultima_salida',
      'ultimo_mensaje'
    ]
  ]

  for (const conversation of serializeConversations()) {
    rows.push([
      conversation.jid,
      conversation.name,
      conversation.status,
      conversation.unreadCount,
      conversation.waitingForHuman ? 'si' : 'no',
      conversation.currentTopic || '-',
      conversation.escalationReason || '-',
      conversation.conflictLevel || '-',
      conversation.tags.join(', '),
      conversation.firstMessageAt || '-',
      conversation.lastMessageAt || '-',
      conversation.lastIncomingAt || '-',
      conversation.lastOutgoingAt || '-',
      conversation.lastMessageText || '-'
    ])
  }

  return '\uFEFF' + rows.map((row) => row.map(escapeCsvValue).join(';')).join('\n')
}
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function setLinkState(updates) {
  linkState = {
    ...linkState,
    ...updates,
    updatedAt: getIsoTimestamp()
  }
}

async function handleAdminRequest(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && requestUrl.pathname === '/') {
    const html = await readFile(LINK_PAGE_FILE, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/admin') {
    const html = await readFile(ADMIN_PAGE_FILE, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/calendar') {
    const html = await readFile(CALENDAR_PAGE_FILE, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/documentation') {
    const html = await readFile(DOCUMENTATION_PAGE_FILE, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/config') {
    const html = await readFile(CONFIG_PAGE_FILE, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/bot-messages') {
    sendJson(res, 200, botMessages)
    return
  }

  if (req.method === 'PUT' && requestUrl.pathname === '/api/bot-messages') {
    const rawBody = await readRequestBody(req)
    const payload = rawBody ? JSON.parse(rawBody) : {}
    const updated = await updateBotMessages(payload)
    sendJson(res, 200, updated)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/conflict-rules') {
    sendJson(res, 200, conflictRules)
    return
  }

  if (req.method === 'PUT' && requestUrl.pathname === '/api/conflict-rules') {
    const rawBody = await readRequestBody(req)
    const payload = rawBody ? JSON.parse(rawBody) : {}
    const updated = await updateConflictRules(payload)
    sendJson(res, 200, updated)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/link-status') {
    sendJson(res, 200, linkState)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/calendar/availability') {
    const days = Number(requestUrl.searchParams.get('days')) || GOOGLE_CALENDAR_DAYS_AHEAD
    const result = await getCalendarAvailability(days)
    sendJson(res, 200, result)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/calendar/overview') {
    const days = Number(requestUrl.searchParams.get('days')) || GOOGLE_CALENDAR_DAYS_AHEAD
    const result = await getCalendarOverview(days)
    sendJson(res, 200, result)
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/logout') {
    await logoutWhatsappSession()
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith('/uploads/')) {
    const fileName = decodeURIComponent(requestUrl.pathname.replace('/uploads/', ''))
    const fileUrl = getUploadFileUrl(fileName)
    const fileBuffer = await readFile(fileUrl)
    res.writeHead(200, { 'Content-Type': getMimeTypeFromFileName(fileName) })
    res.end(fileBuffer)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/conversations') {
    sendJson(res, 200, serializeConversations().map(createConversationSummary))
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/quick-replies') {
    sendJson(res, 200, botMessages.quickReplies)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/conversations-export.csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="conversations.csv"'
    })
    res.end(buildConversationsCsv())
    return
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith('/api/conversations/')) {
    const jid = decodeURIComponent(requestUrl.pathname.replace('/api/conversations/', ''))
    const conversation = getConversation(jid)

    if (!conversation) {
      sendJson(res, 404, { error: 'Conversation not found' })
      return
    }

    sendJson(res, 200, conversation)
    return
  }

  if (req.method === 'PATCH' && requestUrl.pathname.startsWith('/api/conversations/')) {
    const jid = decodeURIComponent(requestUrl.pathname.replace('/api/conversations/', ''))
    const rawBody = await readRequestBody(req)
    const payload = rawBody ? JSON.parse(rawBody) : {}
    const conversation = await applyConversationMetadataUpdate(jid, payload)

    if (!conversation) {
      sendJson(res, 404, { error: 'Conversation not found' })
      return
    }

    sendJson(res, 200, conversation)
    return
  }

  if (req.method === 'DELETE' && requestUrl.pathname.startsWith('/api/conversations/')) {
    const jid = decodeURIComponent(requestUrl.pathname.replace('/api/conversations/', ''))
    const removed = await removeConversation(jid)

    if (!removed) {
      sendJson(res, 404, { error: 'Conversation not found' })
      return
    }

    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && requestUrl.pathname.startsWith('/api/conversations/') && requestUrl.pathname.endsWith('/reply-media')) {
    const jid = decodeURIComponent(requestUrl.pathname.replace('/api/conversations/', '').replace('/reply-media', ''))
    const { fields, upload, fileBuffer } = await parseMultipartForm(req)

    if (!upload) {
      sendJson(res, 400, { error: 'No se recibio ningun archivo' })
      return
    }

    const conversation = await sendUploadedMediaReply(jid, {
      fileBuffer,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      caption: `${fields.caption || ''}`
    })

    sendJson(res, 200, conversation)
    return
  }

  if (req.method === 'POST' && requestUrl.pathname.startsWith('/api/conversations/') && requestUrl.pathname.endsWith('/confirm-turno')) {
    const jid = decodeURIComponent(requestUrl.pathname.replace('/api/conversations/', '').replace('/confirm-turno', ''))
    const payload = await confirmConversationTurn(jid)
    sendJson(res, 200, payload)
    return
  }

  if (req.method === 'POST' && requestUrl.pathname.startsWith('/api/conversations/') && requestUrl.pathname.endsWith('/reply')) {
    const jid = decodeURIComponent(requestUrl.pathname.replace('/api/conversations/', '').replace('/reply', ''))
    const rawBody = await readRequestBody(req)
    const payload = rawBody ? JSON.parse(rawBody) : {}
    const conversation = await sendManualReply(jid, `${payload.text || ''}`)
    sendJson(res, 200, conversation)
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}

function startAdminServer() {
  if (adminServerStarted) return

  const server = createServer((req, res) => {
    handleAdminRequest(req, res).catch((error) => {
      console.error('Error en la interfaz de administrador:', error)
      sendJson(res, error?.statusCode || 500, { error: error?.message || 'Internal server error' })
    })
  })

  server.listen(ADMIN_PORT, () => {
    console.log(`Panel de conversaciones disponible en http://localhost:${ADMIN_PORT}/admin`)
  })

  adminServerStarted = true
}

function normalizeIncomingText(text) {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const collapsed = normalized
    .split(' ')
    .map((word) => word.replace(/([a-z])\1{2,}/g, '$1'))
    .join(' ')

  return collapsed
}

function isGreeting(text) {
  return [...GREETING_TEXTS].some((greeting) => text === greeting || text.startsWith(`${greeting} `))
}

function shouldIncludeNameGreeting(jid) {
  const conversation = getConversation(jid)
  return conversation?.shouldUseNameGreeting !== false
}

async function setConversationFlow(jid, updates) {
  await updateConversationMetadata(jid, updates)
}

async function sendText(sock, sender, text, name = '', options = {}) {
  if (!isSocketActive(sock)) return

  const includeGreeting = options.includeGreeting ?? shouldIncludeNameGreeting(sender)
  const finalText = personalizeText(name, text, { includeGreeting })
  const sentMessage = await sock.sendMessage(sender, { text: finalText })
  rememberOwnMessageId(sentMessage?.key?.id)
  await recordConversationMessage({ jid: sender, name, text: finalText, direction: 'out', source: 'bot' })

  if (includeGreeting) {
    await setConversationFlow(sender, { shouldUseNameGreeting: false })
  }
}

async function sendMenu(sock, sender, name = '') {
  if (!isSocketActive(sock)) return

  const finalText = getMenuText(name)
  const conversation = getConversation(sender)
  if (hasRecentBotText(conversation, finalText)) return

  const sentMessage = await sock.sendMessage(sender, { text: finalText })
  rememberOwnMessageId(sentMessage?.key?.id)
  await recordConversationMessage({ jid: sender, name, text: finalText, direction: 'out', source: 'bot' })
  await setConversationFlow(sender, {
    currentTopic: '',
    waitingForHuman: false,
    humanFallbackOffered: false,
    escalationReason: '',
    conflictLevel: '',
    turnBookingStage: '',
    paymentReceiptStatus: '',
    offeredCalendarSlots: [],
    selectedCalendarSlotStart: '',
    selectedCalendarSlotEnd: '',
    calendarEventId: '',
    shouldUseNameGreeting: false
  })
}

async function sendHumanHandoff(sock, sender, name = '', escalationReason = 'Solicitud de atencion humana', conflictLevel = '') {
  await sendText(sock, sender, botMessages.humanHandoff, name)

  const conversation = getConversation(sender)

  await setConversationFlow(sender, {
    currentTopic: 'human',
    waitingForHuman: true,
    humanFallbackOffered: false,
    status: conflictLevel === 'amenaza' || conflictLevel === 'agresion' ? 'urgente' : 'pendiente',
    tags: conflictLevel === 'amenaza'
      ? ['operador', conflictLevel, 'riesgo']
      : conflictLevel
        ? ['operador', conflictLevel]
        : ['operador'],
    escalationReason,
    conflictLevel,
    turnBookingStage: '',
    humanPauseUntil: conversation?.humanPauseEnabled === false ? '' : getHumanPauseUntilDate(),
    shouldUseNameGreeting: false
  })
}

async function handleTopicFollowUp(sock, sender, text, name, conversation) {
  if (!conversation) return false

  if (conversation.waitingForHuman) {
    if (!conversation.humanFallbackOffered) {
      await sendText(sock, sender, botMessages.topicFollowups.waitingHumanFirstOffer, name, { includeGreeting: false })
      await sendMenu(sock, sender, name)
      await setConversationFlow(sender, {
        waitingForHuman: false,
        humanFallbackOffered: true,
        currentTopic: '',
        shouldUseNameGreeting: false
      })
      return true
    }

    await sendText(sock, sender, botMessages.topicFollowups.waitingHumanRepeat, name, { includeGreeting: false })
    return true
  }

  if (COORDINATING_TOPICS.has(conversation.currentTopic)) {
    if (hasSelectedCalendarSlot(conversation) && conversation.paymentReceiptStatus === 'verified') {
      await sendText(sock, sender, `Tu turno ya esta confirmado para ${formatSlotDateTime(conversation.selectedCalendarSlotStart)} 💚`, name, { includeGreeting: false })
      return true
    }

    if (hasSelectedCalendarSlot(conversation) && conversation.paymentReceiptStatus === 'received') {
      await sendText(sock, sender, 'Ya tenemos tu comprobante 🙌 Apenas verifiquemos el pago, te confirmamos el turno por este medio.', name, { includeGreeting: false })
      return true
    }

    if (hasSelectedCalendarSlot(conversation) && conversation.paymentReceiptStatus === 'requested') {
      await sendText(sock, sender, `Ya reservamos provisoriamente tu horario para ${formatSlotDateTime(conversation.selectedCalendarSlotStart)}. Cuando quieras, envianos el comprobante de la seña y seguimos con la confirmacion.`, name, { includeGreeting: false })
      return true
    }

    if (isCancellationRequest(text) && (conversation.calendarEventId || hasSelectedCalendarSlot(conversation))) {
      await cancelCalendarEvent(conversation)
      await applyConversationMetadataUpdate(sender, {
        offeredCalendarSlots: [],
        selectedCalendarSlotStart: '',
        selectedCalendarSlotEnd: '',
        calendarEventId: ''
      })
      await sendText(sock, sender, 'Dejamos cancelado el turno. Si mas adelante queres coordinar uno nuevo, escribime y te comparto horarios disponibles.', name, { includeGreeting: false })
      return true
    }

    if (isRescheduleRequest(text) && (conversation.calendarEventId || hasSelectedCalendarSlot(conversation))) {
      await cancelCalendarEvent(conversation)
      await applyConversationMetadataUpdate(sender, {
        offeredCalendarSlots: [],
        selectedCalendarSlotStart: '',
        selectedCalendarSlotEnd: '',
        calendarEventId: ''
      })
      await sendText(sock, sender, 'Perfecto, dejamos liberado el horario anterior y te comparto nuevas opciones.', name, { includeGreeting: false })
      await sendAvailableCalendarSlots(sock, sender, name)
      return true
    }

    const selectedOption = extractSchedulingChoice(text, conversation.offeredCalendarSlots)
    if (selectedOption) {
      await applyConversationMetadataUpdate(sender, {
        selectedCalendarSlotStart: selectedOption.start,
        selectedCalendarSlotEnd: selectedOption.end,
        offeredCalendarSlots: []
      })

      let refreshedConversation = getConversation(sender)
      if (refreshedConversation?.paymentReceiptStatus === 'verified') {
        const result = await maybeCreateCalendarEventAfterVerification(sender)
        if (result.ok) return true
        if (result.reason === 'slot_unavailable') {
          await sendText(sock, sender, 'Ese horario ya no esta disponible. Te comparto nuevas opciones para elegir otro turno.', name, { includeGreeting: false })
          await sendAvailableCalendarSlots(sock, sender, name)
          return true
        }
      }

      if (refreshedConversation?.paymentReceiptStatus !== 'received' && refreshedConversation?.paymentReceiptStatus !== 'verified') {
        refreshedConversation = await updateConversationMetadata(sender, { paymentReceiptStatus: 'requested' })
        await sendText(sock, sender, `Reserve provisoriamente la opcion ${selectedOption.id}: ${getSlotOptionLabel(selectedOption)}.\n\n${botMessages.intents.reservaTurno}`, name, { includeGreeting: false })
      } else if (refreshedConversation?.paymentReceiptStatus === 'received') {
        await sendText(sock, sender, `Reserve provisoriamente la opcion ${selectedOption.id}: ${getSlotOptionLabel(selectedOption)}.\n\nYa tenemos tu comprobante 🙌 Apenas verifiquemos el pago, confirmamos el turno y lo agendamos automaticamente.`, name, { includeGreeting: false })
      } else {
        await sendText(sock, sender, `Reserve provisoriamente la opcion ${selectedOption.id}: ${getSlotOptionLabel(selectedOption)}.`, name, { includeGreeting: false })
      }
      return true
    }

    if (conversation.offeredCalendarSlots?.length > 0 && conversation.paymentReceiptStatus === 'received') {
      await sendText(sock, sender, 'Ya tenemos tu comprobante 🙌 Ahora solo falta que elijas una de las opciones que te compartimos para confirmar el turno.', name, { includeGreeting: false })
      return true
    }

    if (conversation.offeredCalendarSlots?.length > 0 && conversation.paymentReceiptStatus === 'verified') {
      await sendText(sock, sender, 'Tu pago ya esta verificado. Elegi una de las opciones que te compartimos y lo dejamos confirmado.', name, { includeGreeting: false })
      return true
    }

    await sendText(sock, sender, botMessages.topicFollowups.coordinandoTurno, name, { includeGreeting: false })
    if (conversation.paymentReceiptStatus !== 'received' && conversation.paymentReceiptStatus !== 'verified') {
      await setConversationFlow(sender, { paymentReceiptStatus: 'requested' })
    }
    await sendAvailableCalendarSlots(sock, sender, name)
    return true
  }

  if (!shouldTreatAsTopicMessage(text)) return false

  if (conversation.currentTopic) {
    await sendText(sock, sender, botMessages.topicFollowups.generic, name, { includeGreeting: false })
    return true
  }

  return false
}

async function handleCommand(sock, sender, text, name) {
  const conversation = getConversation(sender)

  if (isGreeting(text) || text === 'menu') {
    await sendMenu(sock, sender, name)
    return true
  }

  if (shouldHandleBookingFlow(conversation)) {
    if (conversation?.turnBookingStage || conversation?.currentTopic === 'turnos') {
      if (await handleTurnosDetails(sock, sender, text, name)) {
        return true
      }
    } else if (await startBookingFlowFromTopic(sock, sender, text, name, conversation)) {
      return true
    }
  }

  if (await handleInsuranceCoverageFollowUp(sock, sender, text, name, conversation)) {
    return true
  }

  const intent = detectIntent(text)
  const conflict = detectConflictLevel(text)

  if (conflict) {
    await sendHumanHandoff(sock, sender, name, conflict.reason, conflict.level)
    return true
  }

  if (conversation && COORDINATING_TOPICS.has(conversation.currentTopic)) {
    const wantsSchedulingAction = Boolean(
      extractSchedulingChoice(text, conversation.offeredCalendarSlots) ||
      isRescheduleRequest(text) ||
      isCancellationRequest(text)
    )
    if (wantsSchedulingAction && await handleTopicFollowUp(sock, sender, text, name, conversation)) {
      return true
    }
  }

  if (text === '!help') {
    await sendText(sock, sender, applyTemplate(botMessages.commands.help, { botName: BOT_NAME }), name, { includeGreeting: false })
    return true
  }

  if (text === '!time') {
    await sendText(sock, sender, applyTemplate(botMessages.commands.time, { time: getCurrentTime(), timezone: TIMEZONE }), name)
    return true
  }

  if (text === '!about') {
    await sendText(sock, sender, applyTemplate(botMessages.commands.about, { botName: BOT_NAME }), name)
    return true
  }

  if (text === '!ping') {
    await sendText(sock, sender, botMessages.commands.ping, name)
    return true
  }

  if (text === '!broadcast') {
    if (!OWNER_JID || sender !== OWNER_JID) {
      await sendText(sock, sender, botMessages.commands.broadcastForbidden, name)
      return true
    }

    if (BROADCAST_CONTACTS.length === 0) {
      await sendText(sock, sender, botMessages.commands.broadcastNoContacts, name)
      return true
    }

    const broadcastText = applyTemplate(botMessages.commands.broadcastMessage, { botName: BOT_NAME })

    for (const jid of BROADCAST_CONTACTS) {
      const sentMessage = await sock.sendMessage(jid, { text: broadcastText })
      rememberOwnMessageId(sentMessage?.key?.id)

      await recordConversationMessage({
        jid,
        name: '',
        text: broadcastText,
        direction: 'out',
        source: 'bot'
      })
    }

    await sendText(sock, sender, applyTemplate(botMessages.commands.broadcastDone, { count: BROADCAST_CONTACTS.length }), name)
    return true
  }

  if (intent === 'hablar-con-celia') {
    await sendText(sock, sender, botMessages.intents.hablarConCelia, name)
    const existingTags = conversation?.tags || []
    const nextTags = existingTags.includes('operador') ? existingTags : [...existingTags, 'operador']
    await setConversationFlow(sender, {
      currentTopic: 'hablar-con-celia',
      waitingForHuman: true,
      humanFallbackOffered: false,
      escalationReason: 'Solicitud de hablar con Celia',
      tags: nextTags,
      turnBookingStage: '',
      humanPauseUntil: conversation?.humanPauseEnabled === false ? '' : getHumanPauseUntilDate(),
      shouldUseNameGreeting: false
    })
    return true
  }

  const dispatch = INTENT_DISPATCH[intent]
  if (dispatch) {
    await sendText(sock, sender, botMessages.intents[dispatch.messageKey], name)
    const flow = {
      currentTopic: dispatch.topic,
      waitingForHuman: false,
      turnBookingStage: dispatch.topic === 'turnos' ? 'awaiting-insurance' : ''
    }
    if (dispatch.topic === 'turnos') {
      flow.paymentReceiptStatus = ''
      flow.offeredCalendarSlots = []
      flow.selectedCalendarSlotStart = ''
      flow.selectedCalendarSlotEnd = ''
      flow.calendarEventId = ''
    }
    if (dispatch.requestsReceipt && conversation?.paymentReceiptStatus !== 'received' && conversation?.paymentReceiptStatus !== 'verified') {
      flow.paymentReceiptStatus = 'requested'
    }
    await setConversationFlow(sender, flow)
    return true
  }

  if (await handleTopicFollowUp(sock, sender, text, name, conversation)) {
    return true
  }

  return false
}

let activeSocket
let reconnectTimer
let isShuttingDown = false

function clearReconnectTimer() {
  if (!reconnectTimer) return

  clearTimeout(reconnectTimer)
  reconnectTimer = undefined
}

function scheduleReconnect() {
  if (isShuttingDown || reconnectTimer) return

  console.log('Reintentando conexion...')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    startBot().catch((error) => {
      console.error('Error al reconectar:', error)
    })
  }, 3000)
}

function registerShutdownHandlers() {
  const shutdown = (signal) => {
    if (isShuttingDown) return

    isShuttingDown = true
    clearReconnectTimer()

    if (activeSocket) {
      activeSocket.end(new Error(`Proceso detenido por ${signal}`))
    }

    process.exit(0)
  }

  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

async function startBot() {
  if (activeSocket) {
    activeSocket.end(undefined)
    activeSocket = undefined
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: true
  })

  activeSocket = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (lastDisconnect?.error) {
      console.error('Detalle de desconexion:', lastDisconnect.error)
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log('Conexion cerrada.')

      setLinkState({
        connected: false,
        status: shouldReconnect ? 'reconnecting' : 'logged_out',
        qrDataUrl: ''
      })

      if (shouldReconnect) {
        if (activeSocket === sock) {
          activeSocket = undefined
        }

        scheduleReconnect()
      } else {
        activeSocket = undefined
        console.log(`Sesion cerrada. Borra ${AUTH_DIR}/ para volver a autenticar.`)
      }
      return
    }

    if (qr) {
      terminalQrcode.generate(qr, { small: true })
      QRCode.toDataURL(qr, { margin: 1, width: 320 }).then((qrDataUrl) => {
        setLinkState({ connected: false, status: 'qr', qrDataUrl })
      }).catch((error) => {
        console.error('No se pudo generar el QR web:', error)
      })
      console.log('Escanea el QR con WhatsApp.')
    }

    if (connection === 'open') {
      setLinkState({ connected: true, status: 'connected', qrDataUrl: '' })
      console.log('Conectado a WhatsApp.')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return

      const msg = messages[0]
      if (!msg?.message) return

      const sender = msg.key.remoteJid
      if (!sender || !isConversationChat(sender)) return

      if (msg.key.fromMe) {
        if (isOwnAppMessage(msg.key.id)) return

        const name = getContactName(msg)
        const rawText = getTextFromMessage(msg.message)
        const metadata = getMessageMetadata(msg.message)
        const conversation = getConversation(sender)

        await recordConversationMessage({
          jid: sender,
          name,
          text: rawText,
          direction: 'out',
          source: 'human',
          messageType: metadata.messageType,
          mimeType: metadata.mimeType,
          fileName: metadata.fileName
        })

        await updateConversationMetadata(sender, {
          status: 'respondida',
          unreadCount: 0,
          waitingForHuman: false,
          escalationReason: '',
          conflictLevel: '',
          humanPauseUntil: conversation?.humanPauseEnabled === false ? '' : getHumanPauseUntilDate(),
          shouldUseNameGreeting: false
        })
        return
      }

      const name = getContactName(msg)
      const rawText = getTextFromMessage(msg.message)
      const text = normalizeIncomingText(rawText)

      const incomingMedia = await downloadIncomingMedia(msg).catch((error) => {
        console.error('No se pudo descargar el archivo entrante:', error)
        return null
      })

      if (incomingMedia) {
        console.log(`Archivo recibido de ${sender}: ${incomingMedia.fileName}`)
        await recordConversationMessage({
          jid: sender,
          name,
          text: rawText,
          direction: 'in',
          source: 'contact',
          messageType: incomingMedia.messageType,
          mediaUrl: incomingMedia.mediaUrl,
          mimeType: incomingMedia.mimeType,
          fileName: incomingMedia.fileName
        })

        const isReceiptMedia = incomingMedia.messageType === 'image' || (incomingMedia.messageType === 'document' && incomingMedia.mimeType.startsWith('application/pdf'))
        if (isReceiptMedia) {
          const conversation = getConversation(sender)
          if (conversation && conversation.paymentReceiptStatus === 'requested') {
            await applyConversationMetadataUpdate(sender, { paymentReceiptStatus: 'received' })
            if (!isHumanPauseActive(conversation)) {
              await sendText(sock, sender, botMessages.topicFollowups.comprobanteRecibido, name, { includeGreeting: false })
            }
          }
        }
      } else if (text) {
        console.log(`Mensaje recibido de ${sender}: ${rawText}`)
        await recordConversationMessage({ jid: sender, name, text: rawText, direction: 'in', source: 'contact' })
      } else {
        return
      }

      const conversation = getConversation(sender)
      if (isHumanPauseActive(conversation)) {
        greetedContacts.add(sender)
        return
      }

      const isFirstInboundMessage = conversation?.messageCount === 1

      greetedContacts.add(sender)

      if (!text) return

      const wasHandled = await handleCommand(sock, sender, text, name)
      if (wasHandled) return

      if (isFirstInboundMessage) {
        await sendMenu(sock, sender, name)
        return
      }

      if (isGreeting(text)) {
        await sendMenu(sock, sender, name)
        return
      }

      if (hasRecentBotText(conversation, botMessages.defaultReply)) {
        return
      }

      await sendText(sock, sender, botMessages.defaultReply, name)
    } catch (error) {
      console.error('Error procesando mensaje entrante:', error)
    }
  })
}

async function downloadIncomingMedia(msg) {
  const message = msg?.message
  if (!message) return null

  const mediaCandidates = [
    { node: message.imageMessage, messageType: 'image' },
    { node: message.audioMessage, messageType: 'audio' },
    { node: message.videoMessage, messageType: 'video' },
    { node: message.documentMessage, messageType: 'document' },
    { node: message.stickerMessage, messageType: 'image' }
  ]

  const found = mediaCandidates.find(({ node }) => node)
  if (!found) return null

  const buffer = await downloadMediaMessage(msg, 'buffer', {})
  if (!buffer?.length) return null

  await ensureUploadsDir()
  const mimeType = found.node.mimetype || ''
  const suggestedName = found.node.fileName || `${found.messageType}-${randomUUID()}${guessExtensionFromMime(mimeType) || ''}`
  const fileName = sanitizeUploadFileName(suggestedName)
  await writeFile(getUploadFileUrl(fileName), buffer)

  return {
    messageType: found.messageType,
    mediaUrl: getUploadUrl(fileName),
    mimeType,
    fileName
  }
}

function guessExtensionFromMime(mimeType = '') {
  if (mimeType.startsWith('image/jpeg')) return '.jpg'
  if (mimeType.startsWith('image/png')) return '.png'
  if (mimeType.startsWith('image/webp')) return '.webp'
  if (mimeType.startsWith('image/gif')) return '.gif'
  if (mimeType.startsWith('audio/ogg')) return '.ogg'
  if (mimeType.startsWith('audio/mpeg')) return '.mp3'
  if (mimeType.startsWith('audio/')) return '.audio'
  if (mimeType.startsWith('video/mp4')) return '.mp4'
  if (mimeType.startsWith('video/')) return '.mp4'
  if (mimeType === 'application/pdf') return '.pdf'
  return ''
}

await ensureConversationStore()
await ensureConflictRules()
await ensureBotMessages()
startAdminServer()

registerShutdownHandlers()

startBot().catch((error) => {
  console.error('Error al iniciar el bot:', error)
  process.exit(1)
})
