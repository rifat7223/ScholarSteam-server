require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const admin = require('firebase-admin')
const port = process.env.PORT || 3000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()
// middleware
app.use(
  cors({
    origin: [
     process.env.CLIENT_DOMAIN
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {
    // db collection
    const db= client.db('AllScholar')
    const scholarCollection=db.collection('Scholar')
    const ordercollection=db.collection('order')
    const userCollection=db.collection('user')
    const moderatorCollection=db.collection('modreator')
    // role midlewares
    // const verifyADMIN= async (req,res,next)=>{
    //   const email =req.tokenEmail
    //   const user=await userCollection.findOne({email})
    //   if(user?.role!=='admin')
    //     return res
    //   .status(403)
    //   .send({message:'Admin only action',role:user?.role})
    //   next()
    // }
    // const verifySELLER= async (req,res,next)=>{
    //   const email =req.tokenEmail
    //   const user=await userCollection.findOne({email})
    //   if(user?.role!=='modreator')
    //     return res
    //   .status(403)
    //   .send({message:'Admin only action',role:user?.role})
    //   next()
    // }
    // save a plant data on db
    app.post('/scholar', verifyJWT, async(req,res)=>{
      const scholarData=req.body
        scholarData.createdAt = new Date();
      const result=await scholarCollection.insertOne(scholarData)
      res.send(result)
    })
        // GET ALL SCHOLARS (SEARCH + FILTER + SORT)
   
    app.get('/scholar', async (req, res) => {
      try {
        const {
          search = '',
          country = '',
          category = '',
          sort = '',
          order = 'asc'
        } = req.query;

        const query = {};

        // 🔍 SEARCH
        if (search) {
          query.$or = [
            { scholarshipName: { $regex: search, $options: 'i' } },
            { universityName: { $regex: search, $options: 'i' } },
            { degree: { $regex: search, $options: 'i' } },
          ];
        }

        // 🎯 FILTER
        if (country) query.universityCountry = country;
        if (category) query.scholarshipCategory = category;

        // 🔃 SORT
        const sortQuery = {};
        if (sort === 'fees') {
          sortQuery.applicationFees = order === 'desc' ? -1 : 1;
        }
        if (sort === 'date') {
          sortQuery.createdAt = order === 'desc' ? -1 : 1;
        }

        const result = await scholarCollection
          .find(query)
          .sort(sortQuery)
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Server error' });
      }
    });
    // all scholar get
    app.get('/scholar',async(req,res)=>{
     
      const result=await scholarCollection.find().toArray()
      res.send(result)
    })
    app.get('/scholar/:id',async(req,res)=>{
     const id=req.params.id
      const result=await scholarCollection.findOne({_id:new ObjectId(id)})
      res.send(result)
    })
// payment
   app.post('/create-checkout-session', async (req, res) => {
  try {
    const paymentInfo = req.body
    console.log('Payment Info:', paymentInfo)

    const {
      scholarId,
      scholarshipName,
      universityName,
      applicationFees,
      serviceCharge,
      student,
    } = paymentInfo

    
    if (!scholarshipName || !student?.email) {
      return res.status(400).send({ error: 'Missing required data' })
    }

    const totalAmount =
      Number(applicationFees || 0) + Number(serviceCharge || 0)

    if (totalAmount <= 0) {
      return res.status(400).send({ error: 'Invalid payment amount' })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],

      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: scholarshipName,
              description: universityName,
            },
            unit_amount: totalAmount * 100, // cents
          },
          quantity: 1,
        },
      ],

      customer_email: student.email,

      metadata: {
        scholarId,
        studentEmail: student.email,
      },

     success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_DOMAIN}/plant/${scholarId}`,
    })

    res.send({ url: session.url })
  } catch (error) {
    console.error('Stripe Error:', error)
    res.status(500).send({ error: error.message })
  }
})

app.post('/payment-success', async (req, res) => {
  try {
    const { sessionId } = req.body

    if (!sessionId) {
      return res.status(400).send({ error: 'Session ID missing' })
    }

    // Retrieve the Stripe session
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    // console.log('Stripe session:', session)
    const scholar=await scholarCollection.findOne({_id: new ObjectId(session.metadata.scholarId)})
const order=await ordercollection.findOne({ transactionId:session.payment_intent})
    if (session.payment_status === 'paid'&& scholar&& !order) {
      //  Save payment info to MongoDB
      const paymentData = {
        status:'pending',
        sessionId: session.id,
        transactionId:session.payment_intent,
        scholarId: session.metadata.scholarId,
        studentEmail: session.customer_email,
        amountPaid: session.amount_total / 100,
        paymentStatus: session.payment_status,
        moderator:scholar.moderator,
        timestamp: new Date(),
      }
      const result= await ordercollection.insertOne(paymentData)
   res.send(scholar)
      
      return res.send({
        success: true,
        paymentData,
      })
    } else {
      return res.status(400).send({
        success: false,
        paymentStatus: session.payment_status,
      })
    }
  } catch (error) {
    console.error('Payment verify error:', error)
    res.status(500).send({ error: error.message })
  }
})
// Update a scholar by ID
app.patch('/scholar/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ success: false, message: 'Invalid ID' });
    }

   
    if (updatedData.tuitionFees) updatedData.tuitionFees = Number(updatedData.tuitionFees);
    if (updatedData.applicationFees) updatedData.applicationFees = Number(updatedData.applicationFees);
    if (updatedData.serviceCharge) updatedData.serviceCharge = Number(updatedData.serviceCharge);

    const result = await scholarCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedData }
    );

    if (result.modifiedCount > 0) {
      res.send({ success: true, message: 'Scholarship updated successfully' });
    } else {
      res.status(404).send({ success: false, message: 'Scholarship not found or no changes made' });
    }
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).send({ success: false, message: 'Server error' });
  }
});

// get all orders
// app.get('/my-orders/',verifyJWT, async(req,res)=>{

//   const result=await ordercollection.find({
//   studentEmail:req.tokenEmail}).toArray()
//    res.send(result)
// })
  app.get('/my-orders', verifyJWT, async (req, res) => {
      const orders = await ordercollection
        .find({ studentEmail: req.tokenEmail })
        .sort({ timestamp: -1 })
        .toArray();
      res.send(orders);
    });
// Delete order from ordercollection
// Cancel order (moderator)
app.delete('/orders/:id', verifyJWT, async (req, res) => {
  const { id } = req.params

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: 'Invalid order id' })
  }

  // Ensure only the assigned moderator can cancel
  const order = await ordercollection.findOne({
    _id: new ObjectId(id),
    'moderator.email': req.tokenEmail,
  })

  if (!order) {
    return res.status(403).send({ message: 'Forbidden action' })
  }

  const result = await ordercollection.deleteOne({
    _id: new ObjectId(id),
  })

  res.send({
    success: true,
    message: 'Order cancelled successfully',
    deletedCount: result.deletedCount,
  })
})



// app.get('/my-modreator/:email',async(req,res)=>{
//   const email=req.params.email
//   const result=await ordercollection.find({
//  'moderator.email':email}).toArray()
//    res.send(result)
// })
app.get('/my-moderator', verifyJWT, async (req, res) => {
      const orders = await ordercollection
        .find({ 'moderator.email': req.tokenEmail })
        .toArray();
      res.send(orders);
    });

     app.patch('/orders/status/:id', verifyJWT, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid order ID' });

      const result = await ordercollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );

      res.send(result);
    });
app.get('/my-scholar', verifyJWT, async (req, res) => {
  try {
    const email = req.tokenEmail; // ✅ from verified JWT
    const result = await scholarCollection.find({
      'moderator.email': email
    }).toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: 'Server error' });
  }
});
// Delete a scholar by ID
app.delete('/scholar/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ success: false, message: 'Invalid ID' });
    }

    const result = await scholarCollection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 1) {
      res.send({ success: true, message: 'Scholar deleted successfully' });
    } else {
      res.status(404).send({ success: false, message: 'Scholar not found' });
    }
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).send({ success: false, message: 'Server error' });
  }
});

// user data save or update
app.post('/user', async(req,res)=>{
  const userdata=req.body
  userdata.create_at=new Date().toISOString()
  userdata.last_login=new Date().toISOString()
  userdata.role='student'
  const query={
   email:userdata.email,
  }
  const alreadyExist=await userCollection.findOne(
   query
  )
  console.log('user already exist---->',!!alreadyExist)
  if(alreadyExist){
    console.log('updating user info--->')
    const result=await userCollection.updateOne(query,{
      $set:{
        last_login:new Date().toISOString()
      }
    })
    return res.send(result)
  }

 console.log('saving new user info--->')

const result=await userCollection.insertOne(userdata)
console.log(userdata)
  res.send(result)
})

// get a users by role
app.get('/users/role',verifyJWT,async(req,res)=>{
 
  const result=await userCollection.findOne({email:req.tokenEmail})
  res.send({role:result?.role})
})
    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
    // become modreator repuest
   app.post('/become-seller', verifyJWT, async (req, res) => {
  const email = req.tokenEmail; 

  // check if already requested
  const alreadyExist = await moderatorCollection.findOne({ email });

  if (alreadyExist) {
    return res
      .status(409)
      .send({ message: 'Already requested' });
  }

  //  insert only if not exists
  const result = await moderatorCollection.insertOne({ email });

  res.send(result);
});
// get all modreator request for admin
app.get('/modreator-request',verifyJWT, async(req,res)=>{
   const result = await moderatorCollection.find().toArray();

  res.send(result);
})
// get all users for admin
app.get('/users',verifyJWT, async(req,res)=>{
  const adminEmail=req.tokenEmail
   const result = await userCollection.find({email:{$ne:adminEmail}}).toArray();

  res.send(result);
})

// update user role
app.patch('/update-role',verifyJWT,  async(req,res)=>{
  const {email,role}=req.body
  const result=await userCollection.updateOne({email},{$set:{role}})
  await moderatorCollection.deleteOne({email})
  console.log(result)
  res.send(result)
})
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from Server..')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
