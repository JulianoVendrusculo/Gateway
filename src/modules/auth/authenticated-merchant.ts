import { DocumentType } from '@prisma/client';

export interface AuthenticatedMerchant {
  id: string;
  name: string;
  document: string;
  documentType: DocumentType;
}

declare module 'express-serve-static-core' {
  interface Request {
    merchant?: AuthenticatedMerchant;
  }
}
