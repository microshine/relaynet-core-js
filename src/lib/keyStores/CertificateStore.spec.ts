import { addSeconds, subSeconds } from 'date-fns';

import { generateRSAKeyPair, getPrivateAddressFromIdentityKey } from '../crypto_wrappers/keys';
import Certificate from '../crypto_wrappers/x509/Certificate';
import { issueGatewayCertificate } from '../pki';
import { CertificateStore } from './CertificateStore';

export interface MockStoredCertificateData {
  readonly expiryDate: Date;
  readonly certificateSerialized: ArrayBuffer;
}

export class MockCertificateStore extends CertificateStore {
  public dataByPrivateAddress: {
    // tslint:disable-next-line:readonly-array readonly-keyword
    [privateAddress: string]: MockStoredCertificateData[];
  } = {};

  public clear(): void {
    // tslint:disable-next-line:no-object-mutation
    this.dataByPrivateAddress = {};
  }

  public async forceSave(certificate: Certificate): Promise<void> {
    await this.saveData(
      await certificate.calculateSubjectPrivateAddress(),
      certificate.serialize(),
      certificate.expiryDate,
    );
  }

  public async deleteExpired(): Promise<void> {
    throw new Error('Not implemented');
  }

  protected async retrieveAllSerializations(
    subjectPrivateAddress: string,
  ): Promise<readonly ArrayBuffer[]> {
    const certificateData = this.dataByPrivateAddress[subjectPrivateAddress];
    if (!certificateData) {
      return [];
    }
    return certificateData.map((d) => d.certificateSerialized);
  }

  protected async retrieveLatestSerialization(
    subjectPrivateAddress: string,
  ): Promise<ArrayBuffer | null> {
    const certificateData = this.dataByPrivateAddress[subjectPrivateAddress] ?? [];
    if (certificateData.length === 0) {
      return null;
    }
    const dataSorted = certificateData.sort(
      (a, b) => a.expiryDate.getDate() - b.expiryDate.getDate(),
    );
    return dataSorted[0].certificateSerialized;
  }

  protected async saveData(
    subjectPrivateAddress: string,
    subjectCertificateSerialized: ArrayBuffer,
    subjectCertificateExpiryDate: Date,
  ): Promise<void> {
    const mockData: MockStoredCertificateData = {
      certificateSerialized: subjectCertificateSerialized,
      expiryDate: subjectCertificateExpiryDate,
    };
    const originalCertificateData = this.dataByPrivateAddress[subjectPrivateAddress] ?? [];
    // tslint:disable-next-line:no-object-mutation
    this.dataByPrivateAddress[subjectPrivateAddress] = [...originalCertificateData, mockData];
  }
}

const store = new MockCertificateStore();
beforeEach(() => {
  store.clear();
});

let keyPair: CryptoKeyPair;
let privateAddress: string;
beforeAll(async () => {
  keyPair = await generateRSAKeyPair();
  privateAddress = await getPrivateAddressFromIdentityKey(keyPair.publicKey);
});

describe('save', () => {
  test('Expired certificate should not be saved', async () => {
    const certificate = await generateCertificate(subSeconds(new Date(), 1));

    await store.save(certificate);

    expect(store.dataByPrivateAddress).toBeEmpty();
  });

  test('Valid certificate should be saved', async () => {
    const expiryDate = addSeconds(new Date(), 2);
    const certificate = await generateCertificate(expiryDate);

    await store.save(certificate);

    expect(store.dataByPrivateAddress).not.toBeEmpty();
    expect(store.dataByPrivateAddress).toHaveProperty<readonly MockStoredCertificateData[]>(
      privateAddress,
      [{ expiryDate, certificateSerialized: certificate.serialize() }],
    );
  });
});

describe('retrieveLatest', () => {
  test('Nothing should be returned if certificate does not exist', async () => {
    await expect(store.retrieveLatest(privateAddress)).resolves.toBeNull();
  });

  test('Expired certificate should be ignored', async () => {
    const expiredCertificate = await generateCertificate(subSeconds(new Date(), 1));
    await store.forceSave(expiredCertificate);

    await expect(store.retrieveLatest(privateAddress)).resolves.toBeNull();
  });

  test('Valid certificate should be returned', async () => {
    const certificate = await generateCertificate(addSeconds(new Date(), 2));
    await store.save(certificate);

    const retrievedCertificate = await store.retrieveLatest(privateAddress);

    expect(certificate.isEqual(retrievedCertificate!!)).toBeTrue();
  });
});

describe('retrieveAll', () => {
  test('Nothing should be returned if no certificate exists', async () => {
    await expect(store.retrieveAll(privateAddress)).resolves.toBeEmpty();
  });

  test('Expired certificates should be ignored', async () => {
    const validCertificate = await generateCertificate(addSeconds(new Date(), 2));
    await store.save(validCertificate);
    const expiredCertificate = await generateCertificate(subSeconds(new Date(), 1));
    await store.forceSave(expiredCertificate);

    const allCertificates = await store.retrieveAll(privateAddress);

    expect(allCertificates).toHaveLength(1);
    expect(validCertificate.isEqual(allCertificates[0])).toBeTrue();
  });

  test('Valid certificates should be returned', async () => {
    const certificate1 = await generateCertificate(addSeconds(new Date(), 2));
    await store.save(certificate1);
    const certificate2 = await generateCertificate(addSeconds(new Date(), 5));
    await store.save(certificate2);

    const allCertificates = await store.retrieveAll(privateAddress);

    expect(allCertificates).toHaveLength(2);
    expect(allCertificates.filter((c) => certificate1.isEqual(c))).toHaveLength(1);
    expect(allCertificates.filter((c) => certificate2.isEqual(c))).toHaveLength(1);
  });
});

async function generateCertificate(validityEndDate: Date): Promise<Certificate> {
  return issueGatewayCertificate({
    issuerPrivateKey: keyPair.privateKey,
    subjectPublicKey: keyPair.publicKey,
    validityEndDate,
    validityStartDate: subSeconds(validityEndDate, 1),
  });
}