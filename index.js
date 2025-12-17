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
    app.post('/scholar',async(req,res)=>{
      const scholarData=req.body
      const result=await scholarCollection.insertOne(scholarData)
      res.send(result)
    })
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
      // ✅ Save payment info to MongoDB
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
// get all orders
app.get('/my-orders/:email',async(req,res)=>{
  const email=req.params.email
  const result=await ordercollection.find({
  studentEmail:email}).toArray()
   res.send(result)
})
app.get('/my-modreator/:email',async(req,res)=>{
  const email=req.params.email
  const result=await ordercollection.find({
 'moderator.email':email}).toArray()
   res.send(result)
})
app.get('/my-scholar/:email',async(req,res)=>{
  const email=req.params.email
  const result=await scholarCollection.find({
 'moderator.email':email}).toArray()
   res.send(result)
})
// user data save or update
app.post('/user', async(req,res)=>{
  const userdata=req.body
const result=await userCollection.insertOne(userdata)
  res.send(result)
})
    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
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
