// Campus offices the model can point people to when no other source answers a question.
// The model picks an office by id; the name and link come from here, never from its memory,
// because remembered office names go stale (the model's first guess for social houses was an
// office Middlebury renamed years ago). Each link was opened and its page title read on CHECKED.
// tests/check-feeds.js re-checks every link and flags redirects, which is how renames show up.
import { ToolInputError } from "./errors.js";

const CHECKED = "2026-09-21";

// `handles` only helps the model choose. It isn't shown to users as a claim about the office.
export const OFFICES = {
  dining: {
    name: "Dining Services",
    handles: "meal plans, dining hall hours, food allergies and dietary needs",
    url: "https://www.middlebury.edu/dining-services",
  },
  athletics: {
    name: "Middlebury Athletics",
    handles: "game schedules, teams, athletic facilities like the pool",
    url: "https://athletics.middlebury.edu/",
  },
  health: {
    name: "Health Services",
    handles: "medical care, appointments, what care costs",
    url: "https://www.middlebury.edu/health-services",
  },
  "health-insurance": {
    name: "Student Health Insurance",
    handles: "the insurance requirement and the college's plan",
    url: "https://www.middlebury.edu/student-financial-services/financial-tools-and-resources/student-health-insurance",
  },
  "public-safety": {
    name: "Public Safety",
    handles: "campus safety and parking permits",
    url: "https://www.middlebury.edu/public-safety",
  },
  "visitor-parking": {
    name: "Public Safety: Visitor Parking",
    handles: "parking for visitors and overnight guests' cars",
    url: "https://www.middlebury.edu/public-safety/parking-information/visitor-parking-information",
  },
  "residential-life": {
    name: "Residential Life",
    handles: "housing, roommates, overnight guests",
    url: "https://www.middlebury.edu/residential-life",
  },
  "student-engagement": {
    name: "Student Engagement and Belonging",
    handles: "student organizations, campus activities, social houses",
    url: "https://www.middlebury.edu/student-engagement-belonging",
  },
  "student-employment": {
    name: "Student Employment",
    handles: "campus jobs, including for students without work-study",
    url: "https://www.middlebury.edu/human-resources/student-employment",
  },
  "health-professions": {
    name: "Health Professions Advising",
    handles: "premed and other pre-health advising",
    url: "https://www.middlebury.edu/teaching-learning-research/student-resources/health-professions",
  },
  chemistry: {
    name: "Chemistry Department",
    handles: "chemistry courses, majors, faculty research",
    url: "https://www.middlebury.edu/college/academics/chemistry",
  },
  "special-collections": {
    name: "Special Collections, Middlebury Libraries",
    handles: "rare books, archives, the library's oldest items",
    url: "https://www.middlebury.edu/library/special-collections",
  },
  library: {
    name: "Middlebury Libraries",
    handles: "borrowing, research help, library spaces",
    url: "https://www.middlebury.edu/library",
  },
  "snow-bowl": {
    name: "Middlebury Snow Bowl",
    handles: "the college's ski area: lessons, passes, rentals",
    url: "https://middleburysnowbowl.com/",
  },
  admissions: {
    name: "Admissions",
    handles: "applying, visiting, admissions questions",
    url: "https://www.middlebury.edu/college/admissions",
  },
  its: {
    name: "Information Technology Services",
    handles: "accounts, Wi-Fi, tech help",
    url: "https://www.middlebury.edu/information-technology-services",
  },
  registrar: {
    name: "Office of the Registrar",
    handles: "course registration, class schedules, transcripts",
    url: "https://www.middlebury.edu/registrar",
  },
  ctlr: {
    name: "Center for Teaching, Learning, and Research",
    handles: "tutoring, writing help, undergraduate research",
    url: "https://www.middlebury.edu/teaching-learning-research",
  },
};

const directory = Object.entries(OFFICES)
  .map(([id, o]) => `${id} = ${o.name} (${o.handles})`)
  .join("; ");

export const officesTool = {
  // The result only adds a link card; the model already knows the office's name from the
  // directory below, so chat.js doesn't need to send the result back for another turn.
  displayOnly: true,
  definition: {
    name: "get_office",
    description:
      "Point someone to the right office when no other tool answers; the app shows its link as a card. Never name an office not listed here. " +
      `Offices by id: ${directory}.`,
    input_schema: {
      type: "object",
      properties: { id: { type: "string", enum: Object.keys(OFFICES) } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  async run(input) {
    const office = OFFICES[input.id];
    if (!office) throw new ToolInputError(`id must be one of ${Object.keys(OFFICES).join(", ")}`);
    return {
      content: JSON.stringify({ name: office.name, url: office.url }),
      card: {
        type: "office",
        name: office.name,
        url: office.url,
        source: { label: "middlebury.edu", url: office.url, checkedOn: CHECKED },
      },
    };
  },
};
