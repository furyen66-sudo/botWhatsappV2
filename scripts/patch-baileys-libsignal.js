import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const filePath = resolve('node_modules/@whiskeysockets/baileys/lib/Signal/libsignal.js')

const replacements = [
  {
    from: `const WASignalGroup_1 = require("../../WASignalGroup");\nconst Utils_1 = require("../Utils");\nconst WABinary_1 = require("../WABinary");`,
    to: `const WASignalGroup_1 = require("../../WASignalGroup");\nconst WAProto_1 = require("../../WAProto");\nconst Utils_1 = require("../Utils");\nconst WABinary_1 = require("../WABinary");\nconst IDENTITY_KEY_CATEGORY = 'identity-key';\nconst isBadMacError = (error) => \`${'${error}'}\`.includes('Bad MAC');\nconst extractIdentityFromPreKeyMessage = (ciphertext) => {\n    try {\n        const { identityKey } = WAProto_1.proto.Message.PreKeySignalMessage.decode(ciphertext.slice(1));\n        return identityKey?.length ? Buffer.from(identityKey) : undefined;\n    }\n    catch (_a) {\n        return undefined;\n    }\n};`
  },
  {
    from: `                case 'pkmsg':\n                    result = await session.decryptPreKeyWhisperMessage(ciphertext);\n                    break;\n                case 'msg':\n                    result = await session.decryptWhisperMessage(ciphertext);\n                    break;`,
    to: `                case 'pkmsg':\n                    {\n                        const identityKey = extractIdentityFromPreKeyMessage(ciphertext);\n                        if (identityKey) {\n                            await storage.saveIdentity(addr.toString(), identityKey);\n                        }\n                    }\n                    result = await session.decryptPreKeyWhisperMessage(ciphertext);\n                    break;\n                case 'msg':\n                    try {\n                        result = await session.decryptWhisperMessage(ciphertext);\n                    }\n                    catch (error) {\n                        if (isBadMacError(error)) {\n                            await storage.removeSession(addr.toString());\n                        }\n                        throw error;\n                    }\n                    break;`
  },
  {
    from: `function signalStorage({ creds, keys }) {\n    return {`,
    to: `function signalStorage({ creds, keys }) {\n    const storage = {`
  },
  {
    from: `        storeSession: async (id, session) => {\n            await keys.set({ 'session': { [id]: session.serialize() } });\n        },\n        isTrustedIdentity: () => {\n            return true;\n        },`,
    to: `        storeSession: async (id, session) => {\n            await keys.set({ 'session': { [id]: session.serialize() } });\n        },\n        removeSession: async (id) => {\n            await keys.set({ 'session': { [id]: null } });\n        },\n        loadIdentityKey: async (id) => {\n            const { [id]: key } = await keys.get(IDENTITY_KEY_CATEGORY, [id]);\n            if (key) {\n                return Buffer.from(key);\n            }\n        },\n        saveIdentity: async (id, identityKey) => {\n            const nextKey = Buffer.from(identityKey);\n            const currentKey = await storage.loadIdentityKey(id);\n            const hasChanged = !!currentKey && !currentKey.equals(nextKey);\n            if (hasChanged) {\n                await storage.removeSession(id);\n            }\n            await keys.set({ [IDENTITY_KEY_CATEGORY]: { [id]: nextKey } });\n            return hasChanged;\n        },\n        isTrustedIdentity: async (id, identityKey) => {\n            const currentKey = await storage.loadIdentityKey(id);\n            return !currentKey || currentKey.equals(Buffer.from(identityKey));\n        },`
  },
  {
    from: `        getOurIdentity: () => {\n            const { signedIdentityKey } = creds;\n            return {\n                privKey: Buffer.from(signedIdentityKey.private),\n                pubKey: (0, Utils_1.generateSignalPubKey)(signedIdentityKey.public),\n            };\n        }\n    };\n}`,
    to: `        getOurIdentity: () => {\n            const { signedIdentityKey } = creds;\n            return {\n                privKey: Buffer.from(signedIdentityKey.private),\n                pubKey: (0, Utils_1.generateSignalPubKey)(signedIdentityKey.public),\n            };\n        }\n    };\n    return storage;\n}`
  }
]

const source = await readFile(filePath, 'utf8')

if (source.includes("const IDENTITY_KEY_CATEGORY = 'identity-key';")) {
  console.log('Baileys patch already applied.')
  process.exit(0)
}

let output = source

for (const replacement of replacements) {
  if (!output.includes(replacement.from)) {
    throw new Error(`No se encontro el bloque esperado en ${filePath}`)
  }

  output = output.replace(replacement.from, replacement.to)
}

await writeFile(filePath, output)
console.log('Baileys libsignal patch applied.')
