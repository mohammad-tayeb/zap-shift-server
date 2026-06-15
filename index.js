const dns = require("node:dns/promises");
dns.setServers(["1.1.1.1", "1.0.0.1"]); // 👈 ADD THIS FIRST
const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 5000;
require("dotenv").config();

// generate a tracking id using crypto
const crypto = require("crypto");

//-----------------------------firebase admin
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const serviceAccount = require("./zap-shift-5458b-firebase-adminsdk-fbsvc-4df268b402.json");

initializeApp({
  credential: cert(serviceAccount),
});
//------------------------------firebase admin

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

  return `${prefix}-${date}-${random}`;
}

// stripe testing key
const stripe = require("stripe")(process.env.STRIPE_KEY);

// mongodb
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { decode } = require("node:punycode");

app.use(cors());
app.use(express.json());

console.log("user:", process.env.DB_USER);
console.log("pass:", process.env.DB_PASSWORD);

//----------------------------------------------------------jwt middleware
const varifyFirebaseToken = async (req, res, next) => {
  const token = req.headers.authorization; //Get the Authorization Header

  //Check if Token Exists if not return with an error message
  if (!token) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }

  try {
    const idToken = token.split(" ")[1]; //Extract Only the Firebase Token not the "bearer"
    const decoded = await getAuth().verifyIdToken(idToken); //Verify the Token
    console.log("decoded:", decoded);
    req.decoded_email = decoded.email; //attaching the authenticated user's email to the request object
    next();
  } catch (error) {
    console.log(error);
    return res.status(401).send({ message: "Unauthorized Access" });
  }
};
//----------------------------------------------------------jwt

// mongodb
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.z0jqk.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_shift_db");
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentHistoryCollection = db.collection("paymentHistory");

    //new user data posting in database
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        return res.send({ message: "user already exist" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // getting all parcels using user email
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }

      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    // getting all payment history using user email
    app.get("/parcelsHistory", varifyFirebaseToken, async (req, res) => {
      const query = {};
      console.log("header:", req.headers);
      const { email } = req.query;
      if (email) {
        query.customerEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Fornbidden" });
        }
      }

      const options = { sort: { createdAt: -1 } };
      const cursor = paymentHistoryCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    //post parcel data to the db
    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    //get parcel data according to parcel._id
    app.get("/parcel/:id", async (req, res) => {
      const id = req.params.id;

      const parcel = await parcelsCollection.findOne({
        _id: new ObjectId(id),
      });

      res.send(parcel);
    });

    //get paymentHistory data according to parcel._id
    app.get("/paymentHistory/:id", async (req, res) => {
      const id = req.params.id;
      const parcel = await paymentHistoryCollection.findOne({
        transactionId: id,
      });
      res.send(parcel);
    });

    //delete a specific parcel
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // stripe route
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = paymentInfo.cost * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      console.log(session);
      res.send({ url: session.url });
    });

    // Stripe payment verify and update payment status
    app.patch("/verify-payment", async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        if (!sessionId) {
          return res.status(400).send({
            success: false,
            message: "Session ID is required",
          });
        }

        console.log("Session ID:", sessionId);

        // Retrieve Stripe session
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Check if payment already exists
        const transactionId = session.payment_intent;

        const paymentExist = await paymentHistoryCollection.findOne({
          transactionId,
        });

        if (paymentExist) {
          return res.send({
            success: true,
            message: "Payment already verified",
            trackingId: paymentExist.trackingId || null,
            transactionId,
          });
        }

        // Make sure payment was successful
        if (session.payment_status !== "paid") {
          return res.send({
            success: false,
            message: "Payment not completed",
          });
        }

        // Generate tracking ID
        const trackingId = generateTrackingId();

        // Update parcel
        const parcelResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(session.metadata.parcelId) },
          {
            $set: {
              payment_status: "paid",
              trackingId,
              transactionId,
            },
          },
        );

        // Payment history document
        const paymentHistory = {
          amount: session.amount_total / 100,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId,
          paymentStatus: session.payment_status,
          trackingId,
          paidAt: new Date(),
        };

        // Insert payment history
        const paymentResult =
          await paymentHistoryCollection.insertOne(paymentHistory);

        return res.send({
          success: true,
          message: "Payment verified successfully",
          trackingId,
          transactionId,
          modifyParcel: parcelResult,
          paymentHistory: paymentResult,
        });
      } catch (error) {
        console.error(error);

        return res.status(500).send({
          success: false,
          message: "Internal Server Error",
          error: error.message,
        });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("server is running");
});
app.listen(port, () => {
  console.log(`Server Running: ${port}`);
});
