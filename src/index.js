import 'dotenv/config'
import { randomUUID, webcrypto } from 'node:crypto'
import { createServer } from 'node:http'
import { basename, extname } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import {
  DisconnectReason,
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
const CONVERSATIONS_DIR = new URL('../data/', import.meta.url)
const CONVERSATIONS_FILE = new URL('../data/conversations.json', import.meta.url)
const CONFLICT_RULES_FILE = new URL('../data/conflict-rules.json', import.meta.url)
const MESSAGES_FILE = new URL('../data/messages.json', import.meta.url)
const UPLOADS_DIR = new URL('../data/uploads/', import.meta.url)
const ADMIN_PAGE_FILE = new URL('../public/admin.html', import.meta.url)
const LINK_PAGE_FILE = new URL('../public/link.html', import.meta.url)
const DOCUMENTATION_PAGE_FILE = new URL('../public/documentation.html', import.meta.url)
const CONFIG_PAGE_FILE = new URL('../public/config.html', import.meta.url)
const CONVERSATION_STATUSES = new Set(['pendiente', 'respondida', 'urgente'])
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
  'reserva-turno': { messageKey: 'reservaTurno', topic: 'reserva-turno' },
  'politica-inasistencia': { messageKey: 'politicaInasistencia', topic: 'politica-inasistencia' },
  'diabetes': { messageKey: 'diabetes', topic: 'diabetes' },
  'descenso-peso': { messageKey: 'descensoPeso', topic: 'descenso-peso' }
}

const DEFAULT_BOT_MESSAGES = {
  menu: [
    'Hola 👋 Gracias por comunicarte con Lic. Celia Soler, Nutricionista.',
    '',
    '📍 Atención presencial en Clínica El Castaño – Consultorios externos (San Luis y Estados Unidos, San Juan).',
    '',
    '¿Sobre qué consulta necesitás información?',
    '',
    '1️⃣ Turnos',
    '2️⃣ Obras sociales',
    '3️⃣ Consulta nutricional',
    '4️⃣ Nutrición deportiva',
    '5️⃣ Antropometría de 5 componentes',
    '6️⃣ Neurología',
    '7️⃣ Valores',
    '8️⃣ Ubicación',
    '9️⃣ Hablar con Celia',
    '',
    'Respondé con el número o el nombre de la opción que necesites 💬'
  ].join('\n'),
  defaultReply: DEFAULT_REPLY,
  intents: {
    turnos: [
      'Para coordinar un turno necesito que me indiques:',
      '',
      '👉 Nombre y apellido',
      '👉 Objetivo de la consulta',
      '👉 Si tenés obra social y cuál',
      '',
      'Una vez recibida la información, te ayudaré a coordinar tu atención.'
    ].join('\n'),
    obrasSociales: [
      'Sí, trabajo con distintas obras sociales:',
      '',
      '✅ AMFFA',
      '✅ Avalian (ACA Salud)',
      '✅ DAMSU',
      '✅ Jerárquicos Salud',
      '✅ Medicus',
      '✅ Swiss Medical',
      '✅ IOSFA',
      '✅ OMINT',
      '✅ OSSEG',
      '✅ Galeno',
      '✅ Sancor Salud',
      '✅ Federada Salud',
      '✅ Andes Salud',
      '✅ NOBIS',
      '✅ Red de Seguro Médico',
      '✅ Prevención Salud',
      '✅ TV Salud',
      '✅ Luz y Fuerza',
      '✅ OSPATCA',
      '✅ OSPE',
      '✅ OSPIDA',
      '✅ OSPIP',
      '✅ OSPIS',
      '✅ Poder Judicial',
      '✅ Policía Federal',
      '✅ Luis Pasteur',
      '✅ Higea Salud',
      '✅ Brindar Salud',
      '✅ Bramed',
      '✅ Leal Médica',
      '',
      'Para verificar cobertura necesito:',
      '',
      '👉 Obra Social',
      '👉 DNI',
      '👉 Número de afiliado/a',
      '👉 Token (si tu obra social lo requiere)',
      '',
      'Con esos datos te confirmaremos la cobertura y el valor correspondiente.'
    ].join('\n'),
    obraSocialNoCubierta: [
      'Actualmente no trabajo con esa obra social.',
      '',
      'De todas formas podés realizar la consulta de manera particular:',
      '',
      '• Consulta o control: $30.000',
      '• Primera consulta + plan alimentario: $60.000',
      '',
      'Si querés coordinar turno, podemos ayudarte 😊'
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
      'Perfecto 😊',
      '',
      'Dejanos tu nombre y tu consulta, y Celia te responderá a la brevedad.'
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
    generic: 'Recibimos tu mensaje 😊 Lo dejamos asentado y te respondemos a la brevedad por este medio 💚'
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

function detectIntent(text, currentTopic = '') {
  if (isOperatorRequest(text)) return 'hablar-con-celia'

  if (text === '1' || includesAny(text, ['sacar turno', 'quiero un turno', 'quiero turno', 'reservar turno', 'agendar turno', 'pedir turno', 'turno por favor'])) return 'turnos'
  if (text === '2' || includesAny(text, ['obras sociales', 'obra social', 'cobertura', 'prepaga', 'afiliado', 'afiliada', 'me cubre', 'me toman'])) return 'obras-sociales'
  if (text === '3' || includesAny(text, ['consulta nutricional', 'que incluye la consulta', 'que incluye consulta', 'plan alimentario', 'plan de comidas', 'que evaluas'])) return 'consulta-nutricional'
  if (text === '4' || includesAny(text, ['nutricion deportiva', 'deportista', 'deportiva', 'crossfit', 'rendimiento deportivo', 'rendimiento', 'entrenamiento', 'entrenando', 'gimnasio', 'corro', 'running', 'futbol', 'rugby'])) return 'nutricion-deportiva'
  if (text === '5' || includesAny(text, ['antropometria', 'antropometria de 5 componentes', '5 componentes', 'composicion corporal', 'medicion corporal'])) return 'antropometria'
  if (text === '6' || includesAny(text, ['neurologia', 'neurologico', 'neurologica', 'epilepsia', 'parkinson', 'alzheimer', 'esclerosis'])) return 'neurologia'
  if (text === '7' || includesAny(text, ['valores', 'valor', 'precio', 'precios', 'cuanto cuesta', 'cuanto sale', 'cuanto vale', 'costo', 'aranceles'])) return 'valores'
  if (text === '8' || includesAny(text, ['ubicacion', 'donde atendes', 'donde queda', 'donde estas', 'direccion', 'consultorio', 'como llegar', 'google maps', 'maps', 'mapa', 'clinica el castano'])) return 'ubicacion'
  if (text === '9') return 'hablar-con-celia'

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
        shouldUseNameGreeting: item.shouldUseNameGreeting !== false,
        messageCount: Array.isArray(item.messages) ? item.messages.length : 0,
        messages: Array.isArray(item.messages) ? item.messages : []
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
      generic: pickString(topicFollowups.generic, DEFAULT_BOT_MESSAGES.topicFollowups.generic)
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

async function recordConversationMessage({ jid, name, text = '', direction, messageType = 'text', mediaUrl = '', mimeType = '', fileName = '' }) {
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
    conflictLevel: conversation.conflictLevel
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

  await activeSocket.sendMessage(jid, payload)

  const conversation = getConversation(jid)
  await recordConversationMessage({
    jid,
    name: conversation?.name || '',
    text: caption.trim(),
    direction: 'out',
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

  await activeSocket.sendMessage(jid, { text: finalText })
  await recordConversationMessage({
    jid,
    name: conversation?.name || '',
    text: finalText,
    direction: 'out'
  })

  await updateConversationMetadata(jid, {
    status: 'respondida',
    unreadCount: 0,
    waitingForHuman: false,
    escalationReason: '',
    conflictLevel: '',
    shouldUseNameGreeting: false
  })

  return getConversation(jid)
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
    const conversation = await updateConversationMetadata(jid, payload)

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
  const includeGreeting = options.includeGreeting ?? shouldIncludeNameGreeting(sender)
  const finalText = personalizeText(name, text, { includeGreeting })
  await sock.sendMessage(sender, { text: finalText })
  await recordConversationMessage({ jid: sender, name, text: finalText, direction: 'out' })

  if (includeGreeting) {
    await setConversationFlow(sender, { shouldUseNameGreeting: false })
  }
}

async function sendMenu(sock, sender, name = '') {
  const finalText = getMenuText(name)
  await sock.sendMessage(sender, { text: finalText })
  await recordConversationMessage({ jid: sender, name, text: finalText, direction: 'out' })
  await setConversationFlow(sender, {
    currentTopic: '',
    waitingForHuman: false,
    humanFallbackOffered: false,
    escalationReason: '',
    conflictLevel: '',
    shouldUseNameGreeting: false
  })
}

async function sendHumanHandoff(sock, sender, name = '', escalationReason = 'Solicitud de atencion humana', conflictLevel = '') {
  await sendText(sock, sender, botMessages.humanHandoff, name)

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
    shouldUseNameGreeting: false
  })
}

async function handleTopicFollowUp(sock, sender, text, name, conversation) {
  if (!conversation || !shouldTreatAsTopicMessage(text)) return false

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

  if (conversation.currentTopic) {
    await sendText(sock, sender, botMessages.topicFollowups.generic, name, { includeGreeting: false })
    return true
  }

  return false
}

async function handleCommand(sock, sender, text, name) {
  const conversation = getConversation(sender)
  const intent = detectIntent(text, conversation?.currentTopic || '')
  const conflict = detectConflictLevel(text)

  if (conflict) {
    await sendHumanHandoff(sock, sender, name, conflict.reason, conflict.level)
    return true
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
      await sock.sendMessage(jid, { text: broadcastText })

      await recordConversationMessage({
        jid,
        name: '',
        text: broadcastText,
        direction: 'out'
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
      shouldUseNameGreeting: false
    })
    return true
  }

  if (text === 'menu') {
    await sendMenu(sock, sender, name)
    return true
  }

  const dispatch = INTENT_DISPATCH[intent]
  if (dispatch) {
    await sendText(sock, sender, botMessages.intents[dispatch.messageKey], name)
    await setConversationFlow(sender, { currentTopic: dispatch.topic, waitingForHuman: false })
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
    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const sender = msg.key.remoteJid
    const name = getContactName(msg)
    const rawText = getTextFromMessage(msg.message)
    const text = normalizeIncomingText(rawText)

    if (!sender || !text) return

    console.log(`Mensaje recibido de ${sender}: ${rawText}`)

    await recordConversationMessage({ jid: sender, name, text: rawText, direction: 'in' })

    if (!greetedContacts.has(sender)) {
      greetedContacts.add(sender)
      await sendMenu(sock, sender, name)
      return
    }

    const wasHandled = await handleCommand(sock, sender, text, name)
    if (wasHandled) return

    if (isGreeting(text)) {
      await sendMenu(sock, sender, name)
      return
    }

    await sendText(sock, sender, botMessages.defaultReply, name)
  })
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
