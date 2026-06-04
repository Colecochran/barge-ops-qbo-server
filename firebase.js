const admin = require("firebase-admin");

if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccount) {
        console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT env var is not set.');
        console.error('[Firebase] Add it to your .env file or Render environment variables.');
        process.exit(1);
    }

    let cert;
    try {
        cert = JSON.parse(serviceAccount);
    } catch (e) {
        console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT is not valid JSON:', e.message);
        process.exit(1);
    }

    admin.initializeApp({
        credential: admin.credential.cert(cert)
    });
}

const db = admin.firestore();

module.exports = { admin, db };