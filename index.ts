import { BusyBar } from '@busy-app/busy-lib';

const bar = new BusyBar({ addr: process.env.BUSY_BAR_ADDR ?? '10.0.4.20' });

const { device, firmware, power, system } = await bar.SystemStatusGet();
console.log(
  `Connected to ${device?.otp_model} (fw ${firmware?.version}), ` +
    `battery ${power?.battery_charge}% (${power?.state}), uptime ${system?.uptime}`
);

const { snapshot } = await bar.BusySnapshotGet();
console.log(`Busy timer: ${snapshot.type}`);
