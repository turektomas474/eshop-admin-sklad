-- Tabulky pro administraci a sklad (spustit jednou v Query Toolu na fotdarky_eshop)

-- Skladová úloha = "vychystej tuto objednávku"; vznikne, když admin předá zaplacenou objednávku skladu
CREATE TABLE fulfillment_tasks (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders(id),
  type       text    NOT NULL DEFAULT 'FULFILL',
  status     text    NOT NULL DEFAULT 'OPEN'
             CHECK (status IN ('OPEN','BATCHED','PICKING','PICKED','CANCELLED')),
  batch_id   integer,
  assignee   text,
  rev        integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Řádky úlohy: co a kde se má vzít
CREATE TABLE fulfillment_task_lines (
  task_id       integer NOT NULL REFERENCES fulfillment_tasks(id) ON DELETE CASCADE,
  line_no       integer NOT NULL,
  variant_id    integer NOT NULL REFERENCES product_variants(id),
  location_code text    NOT NULL REFERENCES locations(code),
  qty_required  integer NOT NULL CHECK (qty_required > 0),
  qty_picked    integer NOT NULL DEFAULT 0 CHECK (qty_picked >= 0),
  PRIMARY KEY (task_id, line_no)
);

-- Picking batch = jedna obchůzka skladu pro více objednávek najednou
CREATE TABLE pick_batches (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status       text NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  assignee     text,
  rev          integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  completed_at timestamptz
);

ALTER TABLE fulfillment_tasks
  ADD CONSTRAINT fulfillment_tasks_batch_fk FOREIGN KEY (batch_id) REFERENCES pick_batches(id);

-- Řádky batche: stejné zboží na stejné pozici je sloučené
CREATE TABLE pick_batch_lines (
  batch_id      integer NOT NULL REFERENCES pick_batches(id) ON DELETE CASCADE,
  variant_id    integer NOT NULL REFERENCES product_variants(id),
  location_code text    NOT NULL REFERENCES locations(code),
  qty_required  integer NOT NULL,
  qty_picked    integer NOT NULL DEFAULT 0 CHECK (qty_picked >= 0),
  PRIMARY KEY (batch_id, variant_id, location_code)
);

-- Rozpis: kolik kusů sloučeného řádku patří které objednávce
CREATE TABLE pick_batch_allocations (
  batch_id      integer NOT NULL,
  variant_id    integer NOT NULL,
  location_code text    NOT NULL,
  task_id       integer NOT NULL REFERENCES fulfillment_tasks(id),
  line_no       integer NOT NULL,
  qty           integer NOT NULL CHECK (qty > 0),
  PRIMARY KEY (batch_id, task_id, line_no),
  FOREIGN KEY (batch_id, variant_id, location_code)
    REFERENCES pick_batch_lines (batch_id, variant_id, location_code) ON DELETE CASCADE
);
