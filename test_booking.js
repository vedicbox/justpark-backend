const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const user = await prisma.user.findFirst();
  const space = await prisma.parkingSpace.findFirst();
  
  console.log("User:", user?.id, "Space:", space?.id);
  
  if (!user || !space) {
    console.log("Need a user and a space to test.");
    return;
  }
  
  console.log("Creating booking...");
  const start = new Date(Date.now() + 3600000); // 1 hour from now
  const end = new Date(Date.now() + 7200000); // 2 hours from now
  
  const booking = await prisma.booking.create({
    data: {
      user_id: user.id,
      space_id: space.id,
      slot_id: 'dummy_slot',
      vehicle_id: 'dummy_vehicle',
      start_time: start,
      end_time: end,
      status: 'pending',
      base_price: 100,
      platform_fee: 5,
      tax_amount: 10,
      total_price: 115,
    }
  });
  
  console.log("Booking created. Status:", booking.status);
  
  const transaction = await prisma.transaction.create({
    data: {
      booking_id: booking.id,
      user_id: user.id,
      amount: 115,
      currency: 'INR',
      payment_method: 'card',
      status: 'pending',
      gateway: 'razorpay',
      gateway_ref: 'order_dummy123',
    }
  });
  
  console.log("Transaction created. Status:", transaction.status);
  
  // Simulate Webhook for payment.failed
  console.log("\nSimulating Razorpay webhook for payment.failed...");
  const webhookBody = {
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          order_id: 'order_dummy123'
        }
      }
    }
  };
  
  const { handleRazorpayWebhook } = require('./src/modules/payments/service');
  // Need to bypass HMAC or just test failPendingBookingAfterPaymentFailure directly
  
  const updatedTx = await prisma.transaction.updateMany({
    where: {
      gateway_ref: 'order_dummy123',
      status: { not: 'completed' }
    },
    data: { status: 'failed' }
  });
  
  console.log("Transaction explicitly marked failed. TX updated:", updatedTx.count);
  
  const finalBooking = await prisma.booking.findUnique({ where: { id: booking.id }});
  console.log("Final Booking Status:", finalBooking.status);
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
