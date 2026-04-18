-- Add per-space parking slots
CREATE TABLE parking_slots (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  space_id    UUID        NOT NULL REFERENCES parking_spaces(id) ON DELETE CASCADE,
  slot_number VARCHAR(20) NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT parking_slots_space_slot_unique UNIQUE (space_id, slot_number)
);

CREATE INDEX idx_parking_slots_space_id ON parking_slots(space_id);

-- Add slot references to bookings and booking locks
ALTER TABLE bookings
  ADD COLUMN slot_id UUID REFERENCES parking_slots(id);

ALTER TABLE booking_locks
  ADD COLUMN slot_id UUID REFERENCES parking_slots(id);

CREATE INDEX idx_bookings_slot_id ON bookings(slot_id);
CREATE INDEX idx_booking_locks_slot_id ON booking_locks(slot_id);

-- Replace the old space-level overlap rule with slot-aware rules
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS no_overlapping_bookings;

ALTER TABLE bookings ADD CONSTRAINT no_overlapping_bookings_per_slot
  EXCLUDE USING GIST (
    slot_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  )
  WHERE (status IN ('confirmed', 'active') AND slot_id IS NOT NULL);

ALTER TABLE bookings ADD CONSTRAINT no_overlapping_bookings_per_space_legacy
  EXCLUDE USING GIST (
    space_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  )
  WHERE (status IN ('confirmed', 'active') AND slot_id IS NULL);
