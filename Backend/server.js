// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// ⚠️ Charger dotenv EN PREMIER
dotenv.config();

// Import de la DB (après dotenv pour que DATABASE_URL soit dispo)
import db from "./db.js";
import { cleanExpiredDemoStores } from './demo-store.js';

// ⚠️ Décommenter UNIQUEMENT si le fichier existe et exporte bien un router
import Demo from './Gestiondemo/demo.js';

// ============================================
// INITIALISATION APP
// ============================================
const app = express();

// ============================================
// MIDDLEWARES GLOBAUX
// ============================================
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://mon-radar.vercel.app",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Demo-Token"],
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// ROUTE RACINE
// ============================================
app.get("/", (req, res) => {
  res.json({
    message: "✅ Serveur backend FootSpace en marche",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// ============================================
// ROUTES PRINCIPALES
// ============================================
app.use('/api/demo', Demo);

const cleanupDemoData = () => cleanExpiredDemoStores(db).catch(error => {
  console.error('Nettoyage des données temporaires de démo impossible:', error.message);
});
cleanupDemoData();
const demoCleanupTimer = setInterval(cleanupDemoData, 60 * 1000);
demoCleanupTimer.unref();
// app.use('/api/creneaux-analyses', CreneauxAnalyses); // si utilisé

// ============================================
// HEALTH CHECK
// ============================================
app.get("/api/health", async (req, res) => {
  try {
    const dbResult = await db.query("SELECT NOW() as current_time");

    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      environment: process.env.NODE_ENV || "development",
      database: "connected",
      databaseTime: dbResult.rows[0].current_time,
      resendConfigured: !!process.env.RESEND_API_KEY,
      cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      database: "disconnected",
      error: error.message,
    });
  }
});

// ============================================
// CONFIG CHECK
// ============================================
app.get("/api/config", (req, res) => {
  const safeConfig = {
    success: true,
    nodeEnv: process.env.NODE_ENV,
    resendConfigured: !!process.env.RESEND_API_KEY,
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    databaseConfigured: !!process.env.DATABASE_URL,
    keyLengths: {
      resend: process.env.RESEND_API_KEY ? process.env.RESEND_API_KEY.length : 0,
      cloudinary: process.env.CLOUDINARY_API_KEY
        ? process.env.CLOUDINARY_API_KEY.length
        : 0,
    },
  };

  res.json(safeConfig);
});

// ============================================
// GESTION DES ERREURS (doit être après toutes les routes)
// ============================================
app.use((err, req, res, next) => {
  console.error("❌ Erreur:", err.stack);

  if (err.name === "ValidationError") {
    return res.status(422).json({
      success: false,
      message: "Erreur de validation",
      errors: err.errors,
    });
  }

  if (err.message?.includes("Resend") || err.message?.includes("email")) {
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'envoi de l'email",
      error:
        process.env.NODE_ENV === "development"
          ? err.message
          : "Service email temporairement indisponible",
    });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Erreur interne du serveur",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// ============================================
// LANCEMENT DU SERVEUR
// ============================================
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║     🚀 SERVEUR Mon radar DÉMARRÉ AVEC SUCCÈS 🚀              ║
╚══════════════════════════════════════════════════════════════╝

📡 PORT: ${PORT}
🌍 Environnement: ${process.env.NODE_ENV || "development"}
📧 Resend: ${process.env.RESEND_API_KEY ? "✅ OUI" : "❌ NON"}
☁️  Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? "✅ OUI" : "❌ NON"}
🗄️  Base de données: ${process.env.DATABASE_URL ? "✅ CONNECTÉE" : "❌ NON CONNECTÉE"}
`);

    if (!process.env.RESEND_API_KEY) {
      console.warn("⚠️  ATTENTION: RESEND_API_KEY manquante - Les emails ne fonctionneront pas");
    }
    if (!process.env.DATABASE_URL) {
      console.warn("⚠️  ATTENTION: DATABASE_URL manquante - La base de données ne fonctionnera pas");
    }
  });
}

export default app;
