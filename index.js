require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query(`
  CREATE TABLE IF NOT EXISTS reservaties (
    id SERIAL PRIMARY KEY,
    naam VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    telefoon VARCHAR(50) NOT NULL,
    datum DATE NOT NULL,
    zaal VARCHAR(100) NOT NULL,
    personen INTEGER NOT NULL,
    type_event VARCHAR(100) NOT NULL,
    bericht TEXT,
    status VARCHAR(20) DEFAULT 'nieuw',
    aangemaakt_op TIMESTAMP DEFAULT NOW(),
    bijgewerkt_op TIMESTAMP DEFAULT NOW()
  )
`).then(() => console.log('Database tabel klaar')).catch(console.error);

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.set('view engine', 'ejs');
app.set('views', __dirname);

app.use(session({
  secret: process.env.SESSION_SECRET || 'geheim123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

function isAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/boeking-succes', (req, res) => res.sendFile(path.join(__dirname, 'boeking-succes.html')));

app.post('/api/reservatie', async (req, res) => {
  const { naam, email, telefoon, datum, zaal, personen, type_event, bericht } = req.body;
  if (!naam || !email || !telefoon || !datum || !zaal || !personen || !type_event) {
    return res.status(400).json({ success: false, bericht: 'Vul alle verplichte velden in.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO reservaties (naam,email,telefoon,datum,zaal,personen,type_event,bericht)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [naam, email, telefoon, datum, zaal, personen, type_event, bericht || '']
    );
    const reservatieId = result.rows[0].id;

    try {
      await transporter.sendMail({
        from: `"Café 't Capucientje" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: `Reservatieaanvraag ontvangen #${reservatieId}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;padding:32px;background:#F5F0E8;">
          <h2 style="color:#5C3D1E;">Bedankt ${naam}!</h2>
          <p style="color:#7A6650;">Uw aanvraag is ontvangen. Wij contacteren u zo snel mogelijk.</p>
          <div style="background:white;border:1px solid #e0d5c0;padding:20px;margin:20px 0;">
            <p><b>Referentie:</b> #${reservatieId}</p>
            <p><b>Datum:</b> ${datum}</p>
            <p><b>Zaal:</b> ${zaal}</p>
            <p><b>Personen:</b> ${personen}</p>
            <p><b>Type:</b> ${type_event}</p>
          </div>
          <p style="color:#C9A84C;font-size:12px;">CAFÉ 'T CAPUCIENTJE — AALST</p>
        </div>`
      });
      await transporter.sendMail({
        from: `"Capucientje" <${process.env.EMAIL_USER}>`,
        to: process.env.OWNER_EMAIL,
        subject: `Nieuwe reservatie: ${naam} — ${datum}`,
        html: `<div style="font-family:Arial,sans-serif;padding:32px;">
          <h2 style="color:#5C3D1E;">Nieuwe reservatie #${reservatieId}</h2>
          <p><b>Naam:</b> ${naam}</p>
          <p><b>Email:</b> ${email}</p>
          <p><b>Telefoon:</b> ${telefoon}</p>
          <p><b>Datum:</b> ${datum}</p>
          <p><b>Zaal:</b> ${zaal}</p>
          <p><b>Personen:</b> ${personen}</p>
          <p><b>Type:</b> ${type_event}</p>
          <p><b>Bericht:</b> ${bericht || '—'}</p>
        </div>`
      });
    } catch (mailErr) {
      console.error('E-mail fout:', mailErr.message);
    }

    res.json({ success: true, id: reservatieId, naam, email, datum, zaal, personen, type_event, bericht: bericht || '' });
  } catch (err) {
    console.error('DB fout:', err.message);
    res.status(500).json({ success: false, bericht: 'Er is iets misgegaan. Probeer opnieuw.' });
  }
});

app.get('/api/beschikbaarheid', async (req, res) => {
  const { datum, zaal } = req.query;
  if (!datum || !zaal) return res.json({ beschikbaar: false });
  try {
    const result = await pool.query(
      `SELECT id FROM reservaties WHERE datum=$1 AND zaal=$2 AND status!='geannuleerd'`,
      [datum, zaal]
    );
    res.json({ beschikbaar: result.rows.length === 0 });
  } catch (err) {
    res.json({ beschikbaar: true });
  }
});

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin-login', { fout: null });
});

app.post('/admin/login', (req, res) => {
  const { gebruikersnaam, wachtwoord } = req.body;
  if (gebruikersnaam === (process.env.ADMIN_USERNAME || 'admin') &&
      wachtwoord === (process.env.ADMIN_PASSWORD || 'admin123')) {
    req.session.admin = true;
    res.redirect('/admin');
  } else {
    res.render('admin-login', { fout: 'Verkeerde gebruikersnaam of wachtwoord.' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin', isAdmin, async (req, res) => {
  try {
    const filter = req.query.status || 'alle';
    let query = `SELECT * FROM reservaties`;
    let params = [];
    if (filter !== 'alle') { query += ` WHERE status=$1`; params = [filter]; }
    query += ` ORDER BY datum ASC, aangemaakt_op DESC`;
    const reservaties = await pool.query(query, params);
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='nieuw') AS nieuw,
        COUNT(*) FILTER (WHERE status='bevestigd') AS bevestigd,
        COUNT(*) FILTER (WHERE status='geannuleerd') AS geannuleerd,
        COUNT(*) AS totaal
      FROM reservaties
    `);
    res.render('admin-dashboard', { reservaties: reservaties.rows, stats: stats.rows[0], filter });
  } catch (err) {
    res.send('Fout: ' + err.message);
  }
});

app.post('/admin/reservatie/:id/status', isAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['nieuw','bevestigd','geannuleerd'].includes(status)) return res.status(400).json({ success: false });
  try {
    await pool.query(`UPDATE reservaties SET status=$1, bijgewerkt_op=NOW() WHERE id=$2`, [status, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.delete('/admin/reservatie/:id', isAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM reservaties WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.listen(PORT, () => console.log(`Server draait op poort ${PORT}`));
