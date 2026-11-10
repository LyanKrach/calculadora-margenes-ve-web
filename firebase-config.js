/* firebase-config.js — PLANTILLA (sin secretos).
 * Copia tu configuración web desde Firebase Console → Configuración del
 * proyecto → "Tus apps" → app web, y pega aquí tus valores. Este archivo NO
 * debe contener claves reales si el repositorio es público: la apiKey de
 * Firebase es un identificador del proyecto y, aunque las reglas de Firestore
 * protegen los datos, no se publica en repositorios públicos.
 * En local, este archivo se usa tal cual. Para publicar, inyecta la config
 * real en el despliegue (por ejemplo, con un secreto del repositorio).
 */
window.FIREBASE_CONFIG = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROYECTO",
  storageBucket: "TU_PROYECTO.firebasestorage.app",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};
