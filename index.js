const axios = require('axios');
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');

const app = express();   // 👈 MUST COME BEFORE ANY app.post/app.get

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


const SECRET_KEY = "supersecretkey"; // later move to .env

// Create admin (run once then remove route)
app.post('/create-admin', async (req, res) => {
  try {
    const { username, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO admins (username, password) VALUES ($1,$2)",
      [username, hashedPassword]
    );

    res.json({ message: "Admin created successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
async function updateMembership(customerId) {
  const result = await pool.query(
    'SELECT points FROM customers WHERE id = $1',
    [customerId]
  );

  const points = result.rows[0].points;
  let membership = "Silver";

  if (points >= 500) {
    membership = "Premium";
  } else if (points >= 200) {
    membership = "Gold";
  }

  await pool.query(
    'UPDATE customers SET membership = $1 WHERE id = $2',
    [membership, customerId]
  );
}

// Home Route
app.get('/', (req, res) => {
  res.send('Salon Backend Running 💈');
});

// Get All Customers
app.get('/customers', async (req, res) => {
  const result = await pool.query('SELECT * FROM customers ORDER BY id DESC');
  res.json(result.rows);
});


// Add Points with Auto Free Service
app.post('/add-points', async (req, res) => {
  const { mobile, points } = req.body;

  try {
    const result = await pool.query(
      'UPDATE customers SET points = points + $1 WHERE mobile = $2 RETURNING *',
      [points, mobile]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }

    let customer = result.rows[0];
    let message = "Points added successfully";
await updateMembership(customer.id);

    // Check for free service
    if (customer.points >= 100) {
  const remainingPoints = customer.points - 100;

  // Update remaining points
  const updated = await pool.query(
    'UPDATE customers SET points = $1 WHERE mobile = $2 RETURNING *',
    [remainingPoints, mobile]
  );

  customer = updated.rows[0];
await axios({
  method: "POST",
  url: "https://www.fast2sms.com/dev/bulkV2",
  headers: {
    authorization: process.env.FAST2SMS_API
  },
  data: {
    route: "v3",
    sender_id: "FSTSMS",
    message: "Congratulations! You unlocked a FREE service at New Famous Hairstyle.",
    language: "english",
    flash: 0,
    numbers: mobile
  }
});

  // Save free service history
  await pool.query(
    'INSERT INTO free_services (customer_id) VALUES ($1)',
    [customer.id]
  );

  message = "🎉 Free Service Unlocked! 100 points redeemed!";
}


    res.json({
      message,
      customer
    });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Deduct Points
app.post('/deduct-points', async (req, res) => {
  const { mobile, points } = req.body;

  try {
    const result = await pool.query(
      'UPDATE customers SET points = points - $1 WHERE mobile = $2 RETURNING *',
      [points, mobile]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// Get Free Service History
app.get('/free-services', async (req, res) => {
  const result = await pool.query(`
    SELECT fs.id, c.name, c.mobile, fs.redeemed_at
    FROM free_services fs
    JOIN customers c ON fs.customer_id = c.id
    ORDER BY fs.redeemed_at DESC
  `);

  res.json(result.rows);
});
// Add Service Record
app.post('/add-service', async (req, res) => {
  const { mobile, service_name, price, points } = req.body;

  try {
    // Get customer
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE mobile = $1',
      [mobile]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const customer = customerResult.rows[0];

    // Insert service record
    await pool.query(
      'INSERT INTO services (customer_id, service_name, price, points_earned) VALUES ($1, $2, $3, $4)',
      [customer.id, service_name, price, points]
    );

    // Add loyalty points automatically
    await pool.query(
      'UPDATE customers SET points = points + $1 WHERE id = $2',
      [points, customer.id]
    );

    res.json({ message: "Service added successfully 💈" });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// Get All Services
app.get('/services', async (req, res) => {
  const result = await pool.query(`
    SELECT s.id, c.name, c.mobile, s.service_name, s.price, s.points_earned, s.created_at
    FROM services s
    JOIN customers c ON s.customer_id = c.id
    ORDER BY s.created_at DESC
  `);

  res.json(result.rows);
});
// Dashboard Stats
app.get('/dashboard', async (req, res) => {
  try {

    // Total customers
    const totalCustomers = await pool.query(
      'SELECT COUNT(*) FROM customers'
    );

    // Total services
    const totalServices = await pool.query(
      'SELECT COUNT(*) FROM services'
    );

    // Total revenue
    const totalRevenue = await pool.query(
      'SELECT COALESCE(SUM(price),0) FROM services'
    );

    // Today's services
    const todayServices = await pool.query(`
      SELECT COUNT(*) FROM services
      WHERE DATE(created_at) = CURRENT_DATE
    `);

    // Today's revenue
    const todayRevenue = await pool.query(`
      SELECT COALESCE(SUM(price),0) FROM services
      WHERE DATE(created_at) = CURRENT_DATE
    `);

    // Free services count
    const freeServices = await pool.query(
      'SELECT COUNT(*) FROM free_services'
    );

    res.json({
      total_customers: totalCustomers.rows[0].count,
      total_services: totalServices.rows[0].count,
      total_revenue: totalRevenue.rows[0].coalesce,
      today_services: todayServices.rows[0].count,
      today_revenue: todayRevenue.rows[0].coalesce,
      free_services_given: freeServices.rows[0].count
    });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// Monthly Revenue Report (Filter by Month)
app.get('/monthly-report', async (req, res) => {
  try {
    const { month } = req.query; // Format: YYYY-MM

    if (!month) {
      return res.status(400).json({
        message: "Please provide month in format YYYY-MM"
      });
    }

    // Services data
    const services = await pool.query(`
      SELECT 
        COUNT(*) AS total_services,
        COALESCE(SUM(price),0) AS total_revenue
      FROM services
      WHERE TO_CHAR(created_at, 'YYYY-MM') = $1
    `, [month]);

    // Free services data
    const freeServices = await pool.query(`
      SELECT COUNT(*) AS free_services
      FROM free_services
      WHERE TO_CHAR(redeemed_at, 'YYYY-MM') = $1
    `, [month]);

    res.json({
      month,
      total_services: services.rows[0].total_services,
      total_revenue: services.rows[0].total_revenue,
      free_services: freeServices.rows[0].free_services
    });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Yearly Report (Filter by Year)
app.get('/yearly-report', async (req, res) => {
  try {
    const { year } = req.query; // Format: YYYY

    if (!year) {
      return res.status(400).json({
        message: "Please provide year in format YYYY"
      });
    }

    // Total yearly services & revenue
    const yearlySummary = await pool.query(`
      SELECT 
        COUNT(*) AS total_services,
        COALESCE(SUM(price),0) AS total_revenue
      FROM services
      WHERE TO_CHAR(created_at, 'YYYY') = $1
    `, [year]);

    // Free services in that year
    const yearlyFree = await pool.query(`
      SELECT COUNT(*) AS free_services
      FROM free_services
      WHERE TO_CHAR(redeemed_at, 'YYYY') = $1
    `, [year]);

    // Month-wise breakdown
    const monthlyBreakdown = await pool.query(`
      SELECT 
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        COUNT(*) AS total_services,
        COALESCE(SUM(price),0) AS total_revenue
      FROM services
      WHERE TO_CHAR(created_at, 'YYYY') = $1
      GROUP BY month
      ORDER BY month
    `, [year]);

    res.json({
      year,
      total_services: yearlySummary.rows[0].total_services,
      total_revenue: yearlySummary.rows[0].total_revenue,
      free_services: yearlyFree.rows[0].free_services,
      monthly_breakdown: monthlyBreakdown.rows
    });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(403).json({ message: "Access denied. No token." });
  }

  const token = authHeader.split(' ')[1];

  try {
    const verified = jwt.verify(token, SECRET_KEY);
    req.admin = verified;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// Yearly Report PDF
app.get('/yearly-report-pdf', authenticateAdmin, async (req, res) => {
  try {
    const { year } = req.query;

    if (!year) {
      return res.status(400).json({
        message: "Please provide year in format YYYY"
      });
    }

    // Fetch yearly summary
    const yearlySummary = await pool.query(`
      SELECT 
        COUNT(*) AS total_services,
        COALESCE(SUM(price),0) AS total_revenue
      FROM services
      WHERE TO_CHAR(created_at, 'YYYY') = $1
    `, [year]);

    const yearlyFree = await pool.query(`
      SELECT COUNT(*) AS free_services
      FROM free_services
      WHERE TO_CHAR(redeemed_at, 'YYYY') = $1
    `, [year]);

    const monthlyBreakdown = await pool.query(`
      SELECT 
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        COUNT(*) AS total_services,
        COALESCE(SUM(price),0) AS total_revenue
      FROM services
      WHERE TO_CHAR(created_at, 'YYYY') = $1
      GROUP BY month
      ORDER BY month
    `, [year]);

    const doc = new PDFDocument();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=yearly_report_${year}.pdf`);

    doc.pipe(res);

    doc.fontSize(20).text("New Famous Hairstyle 💈", { align: 'center' });
    doc.moveDown();

    doc.fontSize(16).text(`Yearly Business Report - ${year}`);
    doc.moveDown();

    doc.fontSize(12).text(`Total Services: ${yearlySummary.rows[0].total_services}`);
    doc.text(`Total Revenue: ₹${yearlySummary.rows[0].total_revenue}`);
    doc.text(`Free Services Given: ${yearlyFree.rows[0].free_services}`);
    doc.moveDown();

    doc.fontSize(14).text("Monthly Breakdown:");
    doc.moveDown();

    monthlyBreakdown.rows.forEach(row => {
      doc.fontSize(12).text(
        `${row.month}  |  Services: ${row.total_services}  |  Revenue: ₹${row.total_revenue}`
      );
    });

    doc.end();

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

