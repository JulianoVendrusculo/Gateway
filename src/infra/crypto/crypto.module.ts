import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { EncryptionService } from './encryption.service';
import { HashingService } from './hashing.service';
import { KeyRing } from './key-ring';

@Global()
@Module({
  providers: [
    {
      provide: KeyRing,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new KeyRing(config.get('ENCRYPTION_KEYS'), config.get('ENCRYPTION_ACTIVE_KEY_ID')),
    },
    {
      provide: EncryptionService,
      inject: [KeyRing],
      useFactory: (keyRing: KeyRing) => new EncryptionService(keyRing),
    },
    {
      provide: HashingService,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new HashingService({
          blindIndexKey: Buffer.from(config.get('BLIND_INDEX_KEY'), 'base64'),
          apiKeyPepper: Buffer.from(config.get('API_KEY_PEPPER'), 'base64'),
        }),
    },
  ],
  exports: [EncryptionService, HashingService],
})
export class CryptoModule {}
