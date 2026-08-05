/**
 * The seed a real shop runs: AN EMPTY SHOP.
 *
 * It creates the three things nothing works without — a branch to trade as, an
 * owner who can log in, and the document counters for the year — and then it
 * stops. No menu, no dining tables, no ingredients, no expenses.
 *
 * That is the point, and it is worth being clear about why, because the
 * obvious "helpful" alternative is the dangerous one. A seeded menu is a menu
 * that can be RUNG UP AND SOLD. A shop that opens selling ผัดไทย and หอยทอด
 * starts its first day with eleven noodle dishes it has to find and delete
 * first, and the one that gets missed is the one a cashier taps at 12:30 —
 * money taken for a dish the kitchen does not make, on a bill that now has to
 * be voided in front of the customer. The same goes for tables: six tables
 * named A1–A6 in a shop with four is a floor plan that lies, and a table that
 * lies gets bills opened on it.
 *
 * So the shop fills its own menu in from จัดการเมนู and its own floor from
 * โต๊ะ & QR. Both screens work with nothing in them.
 *
 * Configured entirely by environment variables, all optional:
 *
 *   SHOP_NAME       ชื่อร้าน                  (default ร้านของฉัน)
 *   SHOP_CODE       รหัสสาขาบนเลขเอกสาร      (default HQ)
 *   OWNER_NAME      ชื่อ-นามสกุลเจ้าของ        (default เจ้าของร้าน)
 *   OWNER_NICKNAME  ชื่อเล่นที่โชว์บนบิล/ครัว   (default = OWNER_NAME)
 *   OWNER_PIN       PIN 4 หลัก               (default: สุ่มให้ แล้วพิมพ์บนจอครั้งเดียว)
 *
 * Safe to run again: it never overwrites a branch setting or a PIN that has
 * been changed since. See prisma/seed-core.ts.
 *
 * Want the noodle shop with a working menu, recipes and options to try things
 * out — or to run the API tests, which need it? `pnpm db:seed:demo`.
 */

import { PrismaClient } from '@prisma/client';
import { resolveNewShop } from '../src/new-shop.js';
import { seedDocSequences, upsertBranch, upsertStaff } from './seed-core.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Resolved BEFORE the first write. A bad SHOP_CODE should stop the run, not
  // leave a half-made shop behind with a branch row and nobody to log in as.
  const shop = resolveNewShop();

  console.log(`กำลังตั้งค่าร้าน "${shop.name}" (${shop.branchCode})…`);

  const branch = await upsertBranch(prisma, {
    name: shop.name,
    branchCode: shop.branchCode,
  });

  const outcome = await upsertStaff(
    prisma,
    branch.id,
    {
      fullName: shop.owner.fullName,
      nickname: shop.owner.nickname,
      position: 'เจ้าของ',
      role: 'OWNER',
      pin: shop.owner.pin,
      wageType: 'MONTHLY',
      wageRateSatang: 0,
      nationality: 'TH',
    },
    // Never. Re-running this seed six months in must not put the owner's PIN
    // back to whatever was on the screen the day the shop was set up.
    { overwrite: false },
  );

  await seedDocSequences(prisma, branch.id);

  console.log('\nเสร็จแล้ว');
  console.log(`  ร้าน: ${branch.name} (${branch.branchCode})`);

  if (outcome === 'created') {
    console.log(`  เจ้าของ: ${shop.owner.fullName}`);
    if (shop.pinWasGenerated) {
      // The only time this PIN is ever readable. It is stored as a bcrypt hash
      // and there is no screen anywhere that can show it again.
      console.log('');
      console.log('  ================================================');
      console.log(`  PIN สำหรับเข้าระบบ: ${shop.owner.pin}`);
      console.log('  จดไว้ก่อนปิดหน้าต่างนี้ — ดูย้อนหลังไม่ได้');
      console.log('  เปลี่ยนได้ทีหลังที่หน้า "พนักงาน"');
      console.log('  ================================================');
    }
  } else {
    console.log(`  เจ้าของ: ${shop.owner.fullName} (มีอยู่แล้ว — ไม่ได้แตะ PIN เดิม)`);
  }

  console.log('');
  console.log('ขั้นต่อไปในหน้าเว็บ:');
  console.log('  1. จัดการเมนู — ใส่หมวดและรายการอาหารของร้าน');
  console.log('  2. โต๊ะ & QR — ใส่โต๊ะตามผังจริง (ขายกลับบ้านใช้ได้เลยแม้ไม่มีโต๊ะ)');
  console.log('  3. ตั้งค่าสาขา — พร้อมเพย์, ค่าเช่า, VAT (ถ้าจดทะเบียนแล้ว)');
  console.log('  4. พนักงาน — เพิ่มคนอื่นและตั้ง PIN ของแต่ละคน');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
