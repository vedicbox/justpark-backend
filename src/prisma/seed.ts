/**
 * JustPark — Database Seed Script
 *
 * Creates comprehensive dev/staging data:
 *   - 1 admin user
 *   - 5 host users (with verified KYC)
 *   - 10 regular users with vehicles
 *   - 20 parking spaces across Indian cities (active)
 *   - Sample bookings in various states
 *   - Sample reviews
 *   - Sample transactions
 *   - Platform config
 *   - Promo codes
 *
 * Run: npm run seed
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = 10;

// Real Indian city coordinates
const CITIES = [
  { city: 'New Delhi',  state: 'Delhi',         geohash: 'ttnfv1', lat: 28.6139, lng: 77.2090 },
  { city: 'Mumbai',     state: 'Maharashtra',   geohash: 'te7ud3', lat: 19.0760, lng: 72.8777 },
  { city: 'Bangalore',  state: 'Karnataka',     geohash: 'tdr1wf', lat: 12.9716, lng: 77.5946 },
  { city: 'Hyderabad',  state: 'Telangana',     geohash: 'tdr5rb', lat: 17.3850, lng: 78.4867 },
  { city: 'Chennai',    state: 'Tamil Nadu',    geohash: 'tf0u5w', lat: 13.0827, lng: 80.2707 },
  { city: 'Pune',       state: 'Maharashtra',   geohash: 'te6tqt', lat: 18.5204, lng: 73.8567 },
  { city: 'Kolkata',    state: 'West Bengal',   geohash: 'tyd6dp', lat: 22.5726, lng: 88.3639 },
  { city: 'Ahmedabad',  state: 'Gujarat',       geohash: 'te1hde', lat: 23.0225, lng: 72.5714 },
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: Seed script must not run in production. Exiting.');
    process.exit(1);
  }

  console.log('🌱  Seeding database...');

  // ─── Platform config
  await prisma.platformConfig.upsert({
    where:  { key: 'commission_rate' },
    update: {},
    create: { key: 'commission_rate', value: { value: 0.10, description: 'Platform commission (10%)' } },
  });
  await prisma.platformConfig.upsert({
    where:  { key: 'tax_rate' },
    update: {},
    create: { key: 'tax_rate', value: { value: 0, description: 'GST rate (0% — MVP, not GST registered)' } },
  });

  // ─── Admin
  const adminPassword = await bcrypt.hash('Admin@123456', BCRYPT_ROUNDS);
  const admin = await prisma.user.upsert({
    where:  { email: 'admin@justpark.com' },
    update: {},
    create: {
      email:          'admin@justpark.com',
      phone:          '+919900000000',
      password_hash:  adminPassword,
      first_name:     'Super',
      last_name:      'Admin',
      role:           'admin',
      email_verified: true,
      phone_verified: true,
      status:         'active',
    },
  });
  console.log(`✅  Admin: ${admin.email}`);

  // ─── 5 Hosts
  const hostPassword = await bcrypt.hash('Host@123456', BCRYPT_ROUNDS);
  const hostData = [
    { email: 'host1@justpark.com', phone: '+919900000001', first_name: 'Rajesh',  last_name: 'Kumar',   bank_name: 'HDFC Bank',   ifsc: 'HDFC0001234' },
    { email: 'host2@justpark.com', phone: '+919900000002', first_name: 'Priya',   last_name: 'Sharma',  bank_name: 'ICICI Bank',  ifsc: 'ICIC0001234' },
    { email: 'host3@justpark.com', phone: '+919900000003', first_name: 'Vikram',  last_name: 'Singh',   bank_name: 'SBI',         ifsc: 'SBIN0001234' },
    { email: 'host4@justpark.com', phone: '+919900000004', first_name: 'Anita',   last_name: 'Patel',   bank_name: 'Axis Bank',   ifsc: 'UTIB0001234' },
    { email: 'host5@justpark.com', phone: '+919900000005', first_name: 'Suresh',  last_name: 'Reddy',   bank_name: 'Kotak Bank',  ifsc: 'KKBK0001234' },
  ];

  const hosts = [];
  for (let i = 0; i < hostData.length; i++) {
    const hd = hostData[i];
    const host = await prisma.user.upsert({
      where:  { email: hd.email },
      update: {},
      create: {
        email: hd.email, phone: hd.phone, password_hash: hostPassword,
        first_name: hd.first_name, last_name: hd.last_name,
        role: 'host', email_verified: true, phone_verified: true, status: 'active',
      },
    });

    const kycId = `aaaaaaaa-0000-0000-0000-00000000000${i + 1}`;
    await prisma.kycDocument.upsert({
      where:  { id: kycId },
      update: {},
      create: {
        id: kycId, user_id: host.id,
        document_type: 'driving_license',
        document_url:  `https://example.com/kyc/host${i + 1}.jpg`,
        status: 'approved', reviewed_by: admin.id, reviewed_at: new Date(),
      },
    });

    await prisma.wallet.upsert({
      where:  { user_id: host.id },
      update: {},
      create: { user_id: host.id, balance: 1000 * (i + 1), currency: 'INR' },
    });

    const bankId = `bbbbbbbb-0000-0000-0000-00000000000${i + 1}`;
    await prisma.bankAccount.upsert({
      where:  { id: bankId },
      update: {},
      create: {
        id: bankId, host_id: host.id,
        account_holder_name:      `${hd.first_name} ${hd.last_name}`,
        account_number_encrypted: 'ENCRYPTED_PLACEHOLDER',
        ifsc_code: hd.ifsc, bank_name: hd.bank_name,
        is_default: true, is_verified: true,
      },
    });

    hosts.push(host);
    console.log(`✅  Host ${i + 1}: ${host.email}`);
  }

  // ─── 10 Regular users
  const userPassword = await bcrypt.hash('User@123456', BCRYPT_ROUNDS);
  const userData = [
    { email: 'user1@justpark.com',  phone: '+919900000010', first_name: 'Arjun',   last_name: 'Mehta',     plate: 'DL01AB1234', make: 'Maruti',  model: 'Swift',    color: 'White'  },
    { email: 'user2@justpark.com',  phone: '+919900000011', first_name: 'Neha',    last_name: 'Singh',     plate: 'MH02CD5678', make: 'Honda',   model: 'City',     color: 'Silver' },
    { email: 'user3@justpark.com',  phone: '+919900000012', first_name: 'Rahul',   last_name: 'Verma',     plate: 'KA03EF9012', make: 'Hyundai', model: 'i20',      color: 'Blue'   },
    { email: 'user4@justpark.com',  phone: '+919900000013', first_name: 'Pooja',   last_name: 'Joshi',     plate: 'TN04GH3456', make: 'Tata',    model: 'Nexon',    color: 'Red'    },
    { email: 'user5@justpark.com',  phone: '+919900000014', first_name: 'Amit',    last_name: 'Gupta',     plate: 'WB05IJ7890', make: 'Toyota',  model: 'Innova',   color: 'Grey'   },
    { email: 'user6@justpark.com',  phone: '+919900000015', first_name: 'Kavita',  last_name: 'Nair',      plate: 'GJ06KL2345', make: 'Ford',    model: 'EcoSport', color: 'Black'  },
    { email: 'user7@justpark.com',  phone: '+919900000016', first_name: 'Sandeep', last_name: 'Pillai',    plate: 'RJ07MN6789', make: 'Kia',     model: 'Seltos',   color: 'White'  },
    { email: 'user8@justpark.com',  phone: '+919900000017', first_name: 'Deepika', last_name: 'Iyer',      plate: 'TS08OP0123', make: 'MG',      model: 'Hector',   color: 'Orange' },
    { email: 'user9@justpark.com',  phone: '+919900000018', first_name: 'Kiran',   last_name: 'Bose',      plate: 'PB09QR4567', make: 'Renault', model: 'Duster',   color: 'Brown'  },
    { email: 'user10@justpark.com', phone: '+919900000019', first_name: 'Manish',  last_name: 'Agarwal',   plate: 'UP10ST8901', make: 'Skoda',   model: 'Octavia',  color: 'Pearl'  },
  ];

  const users = [];
  for (let i = 0; i < userData.length; i++) {
    const ud = userData[i];
    const user = await prisma.user.upsert({
      where:  { email: ud.email },
      update: {},
      create: {
        email: ud.email, phone: ud.phone, password_hash: userPassword,
        first_name: ud.first_name, last_name: ud.last_name,
        role: 'user', email_verified: true, phone_verified: true, status: 'active',
      },
    });

    await prisma.wallet.upsert({
      where:  { user_id: user.id },
      update: {},
      create: { user_id: user.id, balance: 500 + i * 100, currency: 'INR' },
    });

    const vehicleId = `cccccccc-0000-0000-0000-0000000000${String(i + 1).padStart(2, '0')}`;
    await prisma.vehicle.upsert({
      where:  { id: vehicleId },
      update: {},
      create: {
        id: vehicleId, user_id: user.id,
        plate_number: ud.plate, type: 'car',
        make: ud.make, model: ud.model, color: ud.color,
        is_default: true,
      },
    });

    users.push(user);
  }
  console.log(`✅  Users: ${users.length} users created`);

  // ─── 20 Parking spaces across 8 cities
  const spaceDefinitions = [
    // Delhi (4 spaces)
    {
      id: 'dddddddd-0000-0000-0000-000000000001',
      host_idx: 0, city_idx: 0,
      name: 'CP Secure Parking',
      description: 'Covered parking near Connaught Place. 24/7 security, CCTV.',
      address_line1: 'Block A, Connaught Place',
      postal_code: '110001',
      space_type: 'covered' as const,
      total_capacity: 20,
      hourly_rate: 50, daily_rate: 350,
      amenities: ['cctv', 'covered', 'security_guard', 'lighting', 'ev_charging'] as const,
      cancellation_policy: 'flexible' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000002',
      host_idx: 0, city_idx: 0,
      name: 'Karol Bagh Multi-Level Parking',
      description: 'Multi-level covered parking in Karol Bagh shopping district.',
      address_line1: 'Ajmal Khan Road, Karol Bagh',
      postal_code: '110005',
      space_type: 'indoor' as const,
      total_capacity: 50,
      hourly_rate: 40, daily_rate: 280,
      amenities: ['cctv', 'covered', 'lighting'] as const,
      cancellation_policy: 'moderate' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000003',
      host_idx: 1, city_idx: 0,
      name: 'Lajpat Nagar Open Parking',
      description: 'Open-air parking near Lajpat Nagar Market.',
      address_line1: 'Central Market, Lajpat Nagar II',
      postal_code: '110024',
      space_type: 'open_air' as const,
      total_capacity: 15,
      hourly_rate: 30, daily_rate: 200,
      amenities: ['cctv', 'lighting'] as const,
      cancellation_policy: 'flexible' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000004',
      host_idx: 1, city_idx: 0,
      name: 'Saket Mall Basement Parking',
      description: 'Underground parking beneath Select Citywalk Mall, Saket.',
      address_line1: 'A-3 District Centre, Saket',
      postal_code: '110017',
      space_type: 'underground' as const,
      total_capacity: 80,
      hourly_rate: 60, daily_rate: 400,
      amenities: ['cctv', 'covered', 'security_guard', 'lighting', 'gated'] as const,
      cancellation_policy: 'strict' as const,
    },
    // Mumbai (4 spaces)
    {
      id: 'dddddddd-0000-0000-0000-000000000005',
      host_idx: 1, city_idx: 1,
      name: 'Bandra West Open Parking',
      description: 'Open parking in Bandra West near the station.',
      address_line1: '15th Road, Bandra West',
      postal_code: '400050',
      space_type: 'open_air' as const,
      total_capacity: 10,
      hourly_rate: 40, daily_rate: 250,
      amenities: ['cctv', 'lighting'] as const,
      cancellation_policy: 'moderate' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000006',
      host_idx: 2, city_idx: 1,
      name: 'Andheri Station Parking',
      description: 'Covered parking near Andheri Metro and Railway station.',
      address_line1: 'Station Road, Andheri East',
      postal_code: '400069',
      space_type: 'covered' as const,
      total_capacity: 30,
      hourly_rate: 55, daily_rate: 380,
      amenities: ['cctv', 'covered', 'security_guard'] as const,
      cancellation_policy: 'flexible' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000007',
      host_idx: 2, city_idx: 1,
      name: 'BKC Corporate Garage',
      description: 'Premium indoor parking in Bandra-Kurla Complex.',
      address_line1: 'G Block, BKC',
      postal_code: '400051',
      space_type: 'garage' as const,
      total_capacity: 25,
      hourly_rate: 80, daily_rate: 600,
      amenities: ['cctv', 'covered', 'security_guard', 'lighting', 'gated', 'ev_charging'] as const,
      cancellation_policy: 'strict' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000008',
      host_idx: 3, city_idx: 1,
      name: 'Powai IT Park Parking',
      description: 'Spacious parking near Hiranandani Business Park.',
      address_line1: 'Hiranandani Gardens, Powai',
      postal_code: '400076',
      space_type: 'open_air' as const,
      total_capacity: 40,
      hourly_rate: 45, daily_rate: 300,
      amenities: ['cctv', 'lighting'] as const,
      cancellation_policy: 'moderate' as const,
    },
    // Bangalore (3 spaces)
    {
      id: 'dddddddd-0000-0000-0000-000000000009',
      host_idx: 2, city_idx: 2,
      name: 'MG Road Secure Parking',
      description: 'Covered parking on MG Road near Brigade Road.',
      address_line1: 'Brigade Road, MG Road',
      postal_code: '560025',
      space_type: 'covered' as const,
      total_capacity: 20,
      hourly_rate: 45, daily_rate: 300,
      amenities: ['cctv', 'covered', 'lighting'] as const,
      cancellation_policy: 'flexible' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000010',
      host_idx: 3, city_idx: 2,
      name: 'Koramangala EV Parking',
      description: 'EV-friendly parking with fast chargers in Koramangala.',
      address_line1: '5th Block, Koramangala',
      postal_code: '560095',
      space_type: 'covered' as const,
      total_capacity: 12,
      hourly_rate: 60, daily_rate: 400,
      amenities: ['cctv', 'covered', 'ev_charging', 'ev_type2', 'lighting'] as const,
      cancellation_policy: 'moderate' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000011',
      host_idx: 4, city_idx: 2,
      name: 'Whitefield Tech Parking',
      description: 'Large parking facility near ITPL, Whitefield.',
      address_line1: 'ITPL Main Road, Whitefield',
      postal_code: '560066',
      space_type: 'open_air' as const,
      total_capacity: 60,
      hourly_rate: 35, daily_rate: 220,
      amenities: ['cctv', 'security_guard', 'lighting'] as const,
      cancellation_policy: 'flexible' as const,
    },
    // Hyderabad (2 spaces)
    {
      id: 'dddddddd-0000-0000-0000-000000000012',
      host_idx: 3, city_idx: 3,
      name: 'Hitech City Underground Parking',
      description: 'Underground parking near Hitech City Metro.',
      address_line1: 'Cyber Towers, Hitech City',
      postal_code: '500081',
      space_type: 'underground' as const,
      total_capacity: 35,
      hourly_rate: 50, daily_rate: 350,
      amenities: ['cctv', 'covered', 'security_guard', 'lighting', 'gated'] as const,
      cancellation_policy: 'strict' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000013',
      host_idx: 4, city_idx: 3,
      name: 'Banjara Hills Parking',
      description: 'Open parking near Road No. 12, Banjara Hills.',
      address_line1: 'Road No. 12, Banjara Hills',
      postal_code: '500034',
      space_type: 'open_air' as const,
      total_capacity: 18,
      hourly_rate: 40, daily_rate: 250,
      amenities: ['cctv', 'lighting'] as const,
      cancellation_policy: 'flexible' as const,
    },
    // Chennai (2 spaces)
    {
      id: 'dddddddd-0000-0000-0000-000000000014',
      host_idx: 0, city_idx: 4,
      name: 'Anna Nagar Covered Parking',
      description: 'Covered parking in Anna Nagar near Spencer Plaza.',
      address_line1: 'Phase 1, Anna Nagar',
      postal_code: '600040',
      space_type: 'covered' as const,
      total_capacity: 22,
      hourly_rate: 35, daily_rate: 240,
      amenities: ['cctv', 'covered', 'lighting'] as const,
      cancellation_policy: 'moderate' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000015',
      host_idx: 1, city_idx: 4,
      name: 'OMR IT Corridor Parking',
      description: 'Parking lot along the IT corridor on Old Mahabalipuram Road.',
      address_line1: 'Sholinganallur, OMR',
      postal_code: '600119',
      space_type: 'open_air' as const,
      total_capacity: 45,
      hourly_rate: 30, daily_rate: 180,
      amenities: ['cctv', 'security_guard'] as const,
      cancellation_policy: 'flexible' as const,
    },
    // Pune (2 spaces)
    {
      id: 'dddddddd-0000-0000-0000-000000000016',
      host_idx: 2, city_idx: 5,
      name: 'Koregaon Park Garage',
      description: 'Gated garage near the Koregaon Park restaurants.',
      address_line1: 'Lane 5, Koregaon Park',
      postal_code: '411001',
      space_type: 'garage' as const,
      total_capacity: 15,
      hourly_rate: 50, daily_rate: 350,
      amenities: ['cctv', 'covered', 'gated', 'lighting'] as const,
      cancellation_policy: 'strict' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000017',
      host_idx: 3, city_idx: 5,
      name: 'Hinjewadi Phase 1 Parking',
      description: 'IT park parking in Hinjewadi Phase 1.',
      address_line1: 'Phase 1, Hinjewadi IT Park',
      postal_code: '411057',
      space_type: 'open_air' as const,
      total_capacity: 55,
      hourly_rate: 30, daily_rate: 200,
      amenities: ['cctv', 'lighting'] as const,
      cancellation_policy: 'flexible' as const,
    },
    // Kolkata (1 space)
    {
      id: 'dddddddd-0000-0000-0000-000000000018',
      host_idx: 4, city_idx: 6,
      name: 'Park Street Parking',
      description: 'Centrally located parking on iconic Park Street.',
      address_line1: 'Park Street, Central Kolkata',
      postal_code: '700016',
      space_type: 'covered' as const,
      total_capacity: 25,
      hourly_rate: 35, daily_rate: 230,
      amenities: ['cctv', 'covered', 'lighting'] as const,
      cancellation_policy: 'moderate' as const,
    },
    // Ahmedabad (2 spaces)
    {
      id: 'dddddddd-0000-0000-0000-000000000019',
      host_idx: 0, city_idx: 7,
      name: 'SG Highway Corporate Parking',
      description: 'Modern parking complex on SG Highway.',
      address_line1: 'SG Road, Thaltej',
      postal_code: '380054',
      space_type: 'indoor' as const,
      total_capacity: 30,
      hourly_rate: 40, daily_rate: 260,
      amenities: ['cctv', 'covered', 'security_guard', 'lighting'] as const,
      cancellation_policy: 'flexible' as const,
    },
    {
      id: 'dddddddd-0000-0000-0000-000000000020',
      host_idx: 1, city_idx: 7,
      name: 'CG Road Street Parking',
      description: 'Open parking near CG Road shopping area.',
      address_line1: 'CG Road, Navrangpura',
      postal_code: '380009',
      space_type: 'open_air' as const,
      total_capacity: 20,
      hourly_rate: 25, daily_rate: 150,
      amenities: ['cctv'] as const,
      cancellation_policy: 'flexible' as const,
    },
  ];

  const spaces = [];
  for (const sd of spaceDefinitions) {
    const cityInfo = CITIES[sd.city_idx];
    const host     = hosts[sd.host_idx];

    const space = await prisma.parkingSpace.upsert({
      where:  { id: sd.id },
      update: {},
      create: {
        id:             sd.id,
        host_id:        host.id,
        name:           sd.name,
        description:    sd.description,
        address_line1:  sd.address_line1,
        city:           cityInfo.city,
        state:          cityInfo.state,
        postal_code:    sd.postal_code,
        country:        'IN',
        geohash:        cityInfo.geohash,
        space_type:     sd.space_type,
        total_capacity: sd.total_capacity,
        allowed_vehicles: ['car', 'bike'],
        status:         'active',
        cancellation_policy: sd.cancellation_policy,
        min_booking_duration_minutes: 60,
        instant_book:   true,
      },
    });

    // Amenities
    for (const amenity of sd.amenities) {
      await prisma.spaceAmenity.upsert({
        where:  { space_id_amenity: { space_id: space.id, amenity } },
        update: {},
        create: { space_id: space.id, amenity },
      });
    }

    // Schedule (Mon–Sun)
    for (let day = 0; day <= 6; day++) {
      await prisma.spaceSchedule.upsert({
        where:  { space_id_day_of_week: { space_id: space.id, day_of_week: day } },
        update: {},
        create: {
          space_id:   space.id,
          day_of_week: day,
          open_time:  '06:00',
          close_time: '23:00',
          is_closed:  false,
        },
      });
    }

    // Pricing
    await prisma.spacePricingRule.upsert({
      where:  { space_id_rate_type: { space_id: space.id, rate_type: 'hourly' } },
      update: {},
      create: {
        space_id:  space.id,
        rate_type: 'hourly',
        base_rate: sd.hourly_rate,
        currency:  'INR',
        peak_rules: [
          { start_time: '09:00', end_time: '11:00', multiplier: 1.5 },
          { start_time: '17:00', end_time: '20:00', multiplier: 1.5 },
        ],
        weekend_multiplier: 1.2,
        min_price: sd.hourly_rate,
      },
    });

    await prisma.spacePricingRule.upsert({
      where:  { space_id_rate_type: { space_id: space.id, rate_type: 'daily' } },
      update: {},
      create: {
        space_id:  space.id,
        rate_type: 'daily',
        base_rate: sd.daily_rate,
        currency:  'INR',
        min_price: sd.daily_rate,
      },
    });

    // Photo placeholder
    await prisma.spacePhoto.upsert({
      where:  { id: `eeeeeeee${sd.id.slice(8)}` },
      update: {},
      create: {
        id:       `eeeeeeee${sd.id.slice(8)}`,
        space_id: space.id,
        url:      `https://placehold.co/800x600?text=${encodeURIComponent(sd.name)}`,
        display_order: 0,
      },
    });

    spaces.push(space);

    const slotCount = Math.min(Math.max(space.total_capacity, 1), 5);
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
      const slotNumber = `S${slotIndex + 1}`;
      await prisma.parkingSlot.upsert({
        where: {
          space_id_slot_number: {
            space_id: space.id,
            slot_number: slotNumber,
          },
        },
        update: {},
        create: {
          space_id: space.id,
          slot_number: slotNumber,
          is_active: true,
        },
      });
    }
  }
  console.log(`✅  Spaces: ${spaces.length} parking spaces created`);

  // ─── Sample bookings
  const now        = new Date();
  const pastStart  = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 2 days ago
  const pastEnd    = new Date(now.getTime() - 46 * 60 * 60 * 1000);
  const futStart   = new Date(now.getTime() + 24 * 60 * 60 * 1000); // tomorrow
  const futEnd     = new Date(now.getTime() + 26 * 60 * 60 * 1000);

  // Completed booking: user1 at space1
  const completedBooking = await prisma.booking.upsert({
    where:  { id: 'ffffffff-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id:          'ffffffff-0000-0000-0000-000000000001',
      user_id:     users[0].id,
      space_id:    spaces[0].id,
      vehicle_id:  `cccccccc-0000-0000-0000-000000000001`,
      start_time:  pastStart,
      end_time:    pastEnd,
      base_price:  100,
      platform_fee: 15,
      tax_amount:   18,
      total_price:  133,
      status:       'completed',
    },
  });

  // Confirmed (upcoming) booking: user2 at space5
  await prisma.booking.upsert({
    where:  { id: 'ffffffff-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id:          'ffffffff-0000-0000-0000-000000000002',
      user_id:     users[1].id,
      space_id:    spaces[4].id,
      vehicle_id:  `cccccccc-0000-0000-0000-000000000002`,
      start_time:  futStart,
      end_time:    futEnd,
      base_price:  80,
      platform_fee: 12,
      tax_amount:   14.4,
      total_price:  106.4,
      status:       'confirmed',
    },
  });

  // Cancelled booking: user3 at space2
  await prisma.booking.upsert({
    where:  { id: 'ffffffff-0000-0000-0000-000000000003' },
    update: {},
    create: {
      id:          'ffffffff-0000-0000-0000-000000000003',
      user_id:     users[2].id,
      space_id:    spaces[1].id,
      vehicle_id:  `cccccccc-0000-0000-0000-000000000003`,
      start_time:  pastStart,
      end_time:    pastEnd,
      base_price:  80,
      platform_fee: 12,
      tax_amount:   14.4,
      total_price:  106.4,
      status:       'cancelled',
      cancelled_by: 'user',
      cancellation_reason: 'Plans changed',
    },
  });

  console.log('✅  Sample bookings created');

  // ─── Sample reviews (only for completed bookings)
  await prisma.review.upsert({
    where:  { id: 'abababab-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id:         'abababab-0000-0000-0000-000000000001',
      booking_id: completedBooking.id,
      reviewer_id: users[0].id,
      space_id:   spaces[0].id,
      rating:     5,
      body:       'Excellent parking facility! Very secure and well-lit. Highly recommend.',
    },
  });

  console.log('✅  Sample reviews created');

  // ─── Promo codes
  await prisma.promoCode.upsert({
    where:  { code: 'WELCOME50' },
    update: {},
    create: {
      code: 'WELCOME50', discount_type: 'flat', discount_value: 50,
      max_discount: 50, min_booking_amount: 100, usage_limit: 1000,
      valid_from: new Date('2024-01-01'), valid_until: new Date('2027-12-31'), active: true,
    },
  });

  await prisma.promoCode.upsert({
    where:  { code: 'SAVE20' },
    update: {},
    create: {
      code: 'SAVE20', discount_type: 'percentage', discount_value: 20,
      max_discount: 100, min_booking_amount: 200, usage_limit: 500,
      valid_from: new Date('2024-01-01'), valid_until: new Date('2027-12-31'), active: true,
    },
  });

  await prisma.promoCode.upsert({
    where:  { code: 'FESTIVE15' },
    update: {},
    create: {
      code: 'FESTIVE15', discount_type: 'percentage', discount_value: 15,
      max_discount: 75, min_booking_amount: 150, usage_limit: 200,
      valid_from: new Date('2024-01-01'), valid_until: new Date('2027-12-31'), active: true,
    },
  });

  console.log('✅  Promo codes: WELCOME50, SAVE20, FESTIVE15');

  console.log('\n🎉  Seed complete!\n');
  console.log('=== Test Credentials ===');
  console.log('  Admin:   admin@justpark.com   / Admin@123456');
  console.log('  Host 1:  host1@justpark.com   / Host@123456  (Delhi spaces)');
  console.log('  Host 2:  host2@justpark.com   / Host@123456  (Delhi/Mumbai)');
  console.log('  Host 3:  host3@justpark.com   / Host@123456  (Mumbai/Bangalore)');
  console.log('  Host 4:  host4@justpark.com   / Host@123456  (Bangalore/Hyderabad)');
  console.log('  Host 5:  host5@justpark.com   / Host@123456  (Hyderabad/Kolkata)');
  console.log('  User 1:  user1@justpark.com   / User@123456  (Arjun Mehta)');
  console.log('  User 2:  user2@justpark.com   / User@123456  (Neha Singh)');
  console.log('  ...through user10@justpark.com');
  console.log('\n  Promo codes: WELCOME50 | SAVE20 | FESTIVE15\n');
}

main()
  .catch((e) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
