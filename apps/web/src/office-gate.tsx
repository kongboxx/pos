/**
 * What the back office looks like when its chunk cannot be fetched.
 *
 * This is not defensive padding — it is the known cost of the split. The
 * office chunk is deliberately excluded from the service worker precache, so
 * on a tablet with no connection `import('./pages/office/routes.js')` REJECTS.
 * Without a boundary that rejection unmounts the router and the cashier gets
 * a white screen, which looks exactly like the app being broken.
 *
 * So it is caught and named: the back office needs a connection, the till does
 * not, and the way back to work is one tap away. A plain Suspense fallback
 * would spin forever instead, which is worse — it tells the person nothing and
 * they wait.
 */

import { Component, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { path } from './routes.js';

interface State {
  failed: boolean;
}

export class OfficeGate extends Component<{ children: React.ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-slate-100 p-8 text-center">
          <p className="text-xl font-bold">เปิดหน้าหลังร้านไม่ได้</p>
          <p className="max-w-md text-slate-600">
            หน้าจัดการเมนู รายงาน และเงินเดือน ต้องต่อเน็ต
            <br />
            เครื่องนี้เก็บไว้เฉพาะหน้าขายหน้าร้าน เพื่อให้เปิดบิลได้ตอนเน็ตหลุด
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="btn h-12 bg-brand-600 px-6 text-white"
            >
              ลองใหม่
            </button>
            <Link to={path.tables} className="btn h-12 bg-slate-200 px-6 text-slate-700">
              กลับไปหน้าโต๊ะ
            </Link>
          </div>
        </div>
      );
    }

    return (
      <Suspense
        fallback={
          <div className="flex min-h-full items-center justify-center bg-slate-100">
            <p className="text-slate-400">กำลังเปิดหน้าหลังร้าน…</p>
          </div>
        }
      >
        {this.props.children}
      </Suspense>
    );
  }
}
