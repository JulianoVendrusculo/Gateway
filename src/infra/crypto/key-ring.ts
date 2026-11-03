const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_BYTES = 32; // AES-256

/**
 * Chaveiro de chaves de dados (DEKs). Formato: "id1:base64,id2:base64".
 * - A chave ativa cifra novos dados; as demais continuam decifrando (rotação sem downtime).
 * - Ponto de extensão: trocar a origem por KMS/HSM (envelope encryption) sem alterar consumidores.
 */
export class KeyRing {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    spec: string,
    readonly activeKeyId: string,
  ) {
    const map = new Map<string, Buffer>();
    for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const sep = entry.indexOf(':');
      if (sep <= 0) throw new Error('ENCRYPTION_KEYS: entrada sem formato id:base64');
      const id = entry.slice(0, sep);
      const key = Buffer.from(entry.slice(sep + 1), 'base64');
      if (!KEY_ID.test(id)) throw new Error(`ENCRYPTION_KEYS: id de chave inválido "${id}"`);
      if (key.length !== KEY_BYTES) throw new Error(`ENCRYPTION_KEYS: chave "${id}" deve ter ${KEY_BYTES} bytes`);
      if (map.has(id)) throw new Error(`ENCRYPTION_KEYS: id duplicado "${id}"`);
      map.set(id, key);
    }
    if (!map.has(activeKeyId)) throw new Error(`ENCRYPTION_ACTIVE_KEY_ID "${activeKeyId}" não existe no chaveiro`);
    this.keys = map;
  }

  get(keyId: string): Buffer | undefined {
    return this.keys.get(keyId);
  }

  get activeKey(): Buffer {
    return this.keys.get(this.activeKeyId)!;
  }
}
