import { connectedBar, describeConnection, resolveConnection } from '../src/connection';

const conn = await resolveConnection();
console.log(`Route: ${describeConnection(conn)}`);

const bar = await connectedBar();
const { device, firmware, power, system } = await bar.SystemStatusGet();
console.log(
  `Connected to ${device?.otp_model} (fw ${firmware?.version}), ` +
    `battery ${power?.battery_charge}% (${power?.state}), uptime ${system?.uptime}`
);

const { snapshot } = await bar.BusySnapshotGet();
console.log(`Busy timer: ${snapshot.type}`);
