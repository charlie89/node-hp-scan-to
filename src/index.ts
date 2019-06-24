#!/usr/bin/env node
"use strict";

import os from "os";
import fs from "fs";
import path from "path";
import util from "util";

import Bonjour, { Service } from "bonjour";

import Destination from "./Destination";
import ScanJobSettings from "./ScanJobSettings";
import Event from "./Event";
import HPApi from "./HPApi";
import Job from "./Job";

function delay(t: number): Promise<void> {
  return new Promise(function(resolve) {
    setTimeout(resolve, t);
  });
}

async function waitForScanEvent(resourceURI: string): Promise<Event> {
  console.log("Start listening for new ScanEvent");

  let eventTable = await HPApi.getEvents();
  let acceptedScanEvent = null;
  let currentEtag = eventTable.etag;
  while (acceptedScanEvent == null) {
    eventTable = await HPApi.getEvents(currentEtag, 1200);
    currentEtag = eventTable.etag;

    acceptedScanEvent = eventTable.eventTable.events.find(
      ev => ev.isScanEvent && ev.resourceURI === resourceURI
    );
  }
  return acceptedScanEvent;
}

async function waitPrinterUntilItIsReadyToUploadOrCompleted(
  jobUrl: string
): Promise<Job> {
  let job = null;
  let isReadyToUpload = false;
  do {
    job = await HPApi.getJob(jobUrl);
    isReadyToUpload =
      job.pageState === "ReadyToUpload" || job.jobState === "Completed";
    await delay(200);
  } while (!isReadyToUpload);
  return job;
}

async function register(): Promise<string> {
  const walkupScanDestinations = await HPApi.getWalkupScanDestinations();
  const hostname = os.hostname();

  let destinations = walkupScanDestinations.destinations;

  console.log(
    "Host destinations fetched:",
    destinations.map(d => d.name).join(", ")
  );

  let destination = destinations.find(x => x.name === hostname);
  let resourceURI;
  if (destination) {
    console.log(
      `Re-using existing destination: ${hostname} - ${destination.resourceURI}`
    );
    resourceURI = destination.resourceURI;
  } else {
    resourceURI = await HPApi.registerDestination(
      new Destination(hostname, hostname)
    );
    console.log(`New Destination registered: ${hostname} - ${resourceURI}`);
  }
  return resourceURI;
}

async function getNextFile(
  folder: string,
  currentPageNumber: string
): Promise<string> {
  return path.join(folder, `scanPage${currentPageNumber}.jpg`);
}

async function saveScan(event: Event): Promise<void> {
  const destination = await HPApi.getDestination(event.resourceURI);

  const folder = await util.promisify(fs.mkdtemp)(
    path.join(os.tmpdir(), "scan-to-pc")
  );
  console.log(`Target folder: ${folder}`);

  console.log("Selected shortcut: " + destination.shortcut);
  const scanStatus = await HPApi.getScanStatus();
  console.log("Afd is : " + scanStatus.adfState);

  let inputSource = scanStatus.getInputSource();
  let contentType = destination.getContentType();

  let scanJobSettings = new ScanJobSettings(inputSource, contentType);
  const jobUrl = await HPApi.postJob(scanJobSettings);

  console.log("New job created:", jobUrl);

  let job = await HPApi.getJob(jobUrl);
  while (job.jobState !== "Completed") {
    job = await waitPrinterUntilItIsReadyToUploadOrCompleted(jobUrl);

    if (job.jobState == "Completed") {
      continue;
    }

    if (job.jobState === "Processing") {
      if (
        job.pageState == "ReadyToUpload" &&
        job.binaryURL != null &&
        job.currentPageNumber != null
      ) {
        console.log(
          `Ready to download page ${job.currentPageNumber} at:`,
          job.binaryURL
        );

        const destinationFilePath = await getNextFile(
          folder,
          job.currentPageNumber
        );
        const filePath = await HPApi.downloadPage(
          job.binaryURL,
          destinationFilePath
        );
        console.log("Page downloaded to:", filePath);
      } else {
        console.log(`Unknown pageState: ${job.pageState}`);
        await delay(200);
      }
    } else {
      console.log(`Unknown jobState: ${job.jobState}`);
      await delay(200);
    }
  }
  console.log(`Job state: ${job.jobState}, totalPages: ${job.totalPageNumber}`);
}

async function init() {
  let keepActive = true;
  let errorCount = 0;
  while (keepActive) {
    try {
      let resourceURI = await register();

      console.log("Waiting scan event for:", resourceURI);
      const event = await waitForScanEvent(resourceURI);
      console.log("Scan event captured");
      await saveScan(event);
    } catch (e) {
      errorCount++;
      console.error(e);
    }

    if (errorCount === 50) {
      keepActive = false;
    }

    await delay(1000);
  }
}

interface OfficeJetBonjourService extends Service {
  addresses?: string[];
}

function findOfficejetIp(): Promise<string> {
  return new Promise(resolve => {
    const bonjour = Bonjour();
    console.log("Searching printer...");
    let browser = bonjour.find(
      {
        type: "http"
      },
      (service: OfficeJetBonjourService) => {
        console.log(".");
        if (
          service.name.startsWith("Officejet 6500 E710n-z") &&
          service.port === 80 &&
          service.type === "http" &&
          service.addresses != null
        ) {
          browser.stop();
          bonjour.destroy();
          console.log(`Found: ${service.name}`);
          resolve(service.addresses[0]);
        }
      }
    );
    browser.start();
  });
}

async function main() {
  const ip = await findOfficejetIp();
  HPApi.setPrinterIP(ip);
  await init();
}

main();