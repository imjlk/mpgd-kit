import './styles.css';
import { installAitBridge } from './aitBridge';

installAitBridge();

const app = document.querySelector<HTMLDivElement>('#app');

if (app !== null) {
  app.innerHTML = `
    <section class="shell">
      <h1>MPGD AIT Target</h1>
      <p>Bridge installed. Game bundle is copied to <code>public/game</code> during target build.</p>
    </section>
  `;
}
