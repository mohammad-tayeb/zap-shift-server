const dns = require("node:dns/promises");
dns.setServers(["1.1.1.1", "1.0.0.1"]); // 👈 ADD THIS FIRST

const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 5000;
require("dotenv").config();

const crypto = require("crypto");

//-----------------------------firebase admin
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const serviceAccount = require("./zap-shift-5458b-firebase-adminsdk-fbsvc-4df268b402.json");

initializeApp({
  credential: cert(serviceAccount),
});

// stripe testing key
const stripe = require("stripe")(process.env.STRIPE_KEY);

// mongodb
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

app.use(cors());
app.use(express.json());

//----------------------------------------------------------jwt middleware
const varifyFirebaseToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await getAuth().verifyIdToken(idToken);

    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }
};
//----------------------------------------------------------

function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

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
    await client.connect();

    const db = client.db("zap_shift_db");
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentHistoryCollection = db.collection("paymentHistory");
    const ridersCollection = db.collection("riders");

    // ---------------middleware------------
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user?.role != "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // ---------------- USERS ----------------

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

    app.get("/users", varifyFirebaseToken, async (req, res) => {
      const { search = "", role, limit } = req.query;
      const limitNumber = parseInt(limit);
      const query = {};

      // status filter (exact match)
      if (role) {
        query.role = role;
      }

      // search filter (name/email)
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ];
      }

      const result = await usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(limitNumber)
        .toArray();

      res.send(result);
    });

    app.get("/users/:id", varifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      const result = await usersCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    //getting data for statics/dashboard page
    app.get("/rider", async (req, res) => {
      const query = req.query.email;
      const result = await ridersCollection.findOne({
        email: query,
      });
      res.send(result);
    });

    app.get("/users/:email/role", varifyFirebaseToken, async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result?.role || "user");
    });

    app.patch(
      "/users/:id",
      varifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: roleInfo.role } },
        );

        res.send(result);
      },
    );

    app.delete("/users/:id", varifyFirebaseToken, async (req, res) => {
      const id = req.params.id;

      const result = await usersCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });

    // ---------------- PARCELS ----------------

    app.post("/parcels", varifyFirebaseToken, async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();

      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.patch("/parcels/:id", async (req, res) => {
      const { parcelId, riderName, riderId, riderEmail } = req.body;
      const id = req.params.id;

      //update in parcel db
      const queryParcel = { _id: new ObjectId(id) };
      const updateDocParcel = {
        $set: {
          deliveryStatus: "riderAssigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      const resultParcel = await parcelsCollection.updateOne(
        queryParcel,
        updateDocParcel,
      );

      //update in rider db
      const queryRider = { _id: new ObjectId(riderId) };
      const updateDocRider = {
        $set: {
          workStatus: "assignedForPickup",
          assignedForPickupAt: new Date(),
        },
      };
      const resultRider = await ridersCollection.updateOne(
        queryRider,
        updateDocRider,
      );
      console.log(riderEmail, id);
      res.send(resultParcel, resultRider);
    });

    app.get("/parcels", varifyFirebaseToken, async (req, res) => {
      const query = {};
      const { email, deliveryStatus, parcelId, riderEmail } = req.query;

      if (email) {
        query.senderEmail = email;
      }
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      if (parcelId) {
        query.parcelId = parcelId;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch("/parcelStatus/:id", async (req, res) => {
      const { id } = req.params;
      const { deliveryStatus, riderId } = req.body;

      const updateData = {
        deliveryStatus,
      };

      // Add timestamp based on status
      if (deliveryStatus === "parcelAcceptedByRider") {
        updateData.acceptedAt = new Date();
      }

      if (deliveryStatus === "parcelPickedByRider") {
        updateData.pickedUpAt = new Date();
      }

      if (deliveryStatus === "parcelDelivered") {
        updateData.deliveredAt = new Date();
      }

      const result = await parcelsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: updateData,
        },
      );

      if (
        deliveryStatus === "parcelDelivered" ||
        deliveryStatus === "rejectedByRider"
      ) {
        const riderUpdate = {
          workStatus: "available",
        };

        // Give payment only after successful delivery
        if (deliveryStatus === "parcelDelivered") {
          const parcel = await parcelsCollection.findOne({
            _id: new ObjectId(id),
          });

          const weight = Number(parcel.parcelWeight);

          let earning = 40;

          if (weight > 5) {
            earning += (weight - 5) * 10;
          }

          await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            {
              $set: riderUpdate,
              $inc: {
                totalEarnings: earning,
                completedDeliveries: 1,
              },
            },
          );
        } else {
          // Rider rejected the parcel
          await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            {
              $set: riderUpdate,
              $inc: {
                rejectedDeliveries: 1,
              },
            },
          );
        }
      }

      res.send(result);
    });

    app.get("/track/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;

      const parcel = await parcelsCollection.findOne({ trackingId });

      res.send(parcel);
    });

    app.get("/parcel/:id", varifyFirebaseToken, async (req, res) => {
      const id = req.params.id;

      const parcel = await parcelsCollection.findOne({
        _id: new ObjectId(id),
      });

      res.send(parcel);
    });

    app.delete("/parcels/:id", varifyFirebaseToken, async (req, res) => {
      const id = req.params.id;

      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });

    // ---------------- PAYMENT ----------------

    app.get("/parcelsHistory", varifyFirebaseToken, async (req, res) => {
      const query = {};
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

    app.get("/paymentHistory/:id", varifyFirebaseToken, async (req, res) => {
      const id = req.params.id;

      const parcel = await paymentHistoryCollection.findOne({
        transactionId: id,
      });

      res.send(parcel);
    });

    app.post(
      "/create-checkout-session",
      varifyFirebaseToken,
      async (req, res) => {
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

        res.send({ url: session.url });
      },
    );

    app.patch("/verify-payment", varifyFirebaseToken, async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const transactionId = session.payment_intent;

        const paymentExist = await paymentHistoryCollection.findOne({
          transactionId,
        });

        if (paymentExist) {
          return res.send({
            success: true,
            message: "Payment already verified",
          });
        }

        const trackingId = generateTrackingId();

        await parcelsCollection.updateOne(
          { _id: new ObjectId(session.metadata.parcelId) },
          {
            $set: {
              payment_status: "paid",
              paidAt: new Date(),
              deliveryStatus: "pending-pickup",
              trackingId,
              transactionId,
            },
          },
        );

        await paymentHistoryCollection.insertOne({
          amount: session.amount_total / 100,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId,
          paymentStatus: session.payment_status,
          trackingId,
          paidAt: new Date(),
        });

        res.send({
          success: true,
          message: "Payment verified successfully",
          trackingId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Internal Server Error",
        });
      }
    });

    // ---------------- RIDERS ----------------

    app.post("/riders", varifyFirebaseToken, async (req, res) => {
      const riderData = req.body;
      riderData.createdAt = new Date();
      riderData.status = "pending";

      const emailExist = await ridersCollection.findOne({
        email: riderData.email,
      });

      if (emailExist) {
        return res
          .status(409)
          .send({ message: "Already Applied Using This Email" });
      }

      const result = await ridersCollection.insertOne(riderData);
      res.send(result);
    });

    app.get("/riders", varifyFirebaseToken, verifyAdmin, async (req, res) => {
      const { search = "", status, workStatus } = req.query;

      const query = {};

      // status filter (exact match)
      if (status) {
        query.status = status;
      }

      // search filter (name/email)
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ];
      }

      if (workStatus) {
        query.workStatus = workStatus;
      }

      const result = await ridersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.patch(
      "/riders/approve/:id",
      varifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { status, email } = req.body;

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: status,
              workStatus: "available",
              totalEarnings: 0,
              completedDeliveries: 0,
              rejectedDeliveries: 0,
            },
          },
        );

        if (status === "approved") {
          await usersCollection.updateOne(
            { email },
            { $set: { role: "rider" } },
          );
        }

        res.send(result);
      },
    );

    app.delete(
      "/riders/:id",
      varifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;

        const result = await ridersCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      },
    );

    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB connected!");
  } finally {
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
