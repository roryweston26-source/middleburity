// Every request this app makes to a Middlebury source says who it is and links the project.
// It's also required in practice: the athletics calendar answers an empty 200 to requests
// with no User-Agent, which is how production quietly lost every game (2026-09-22).
export const USER_AGENT = "Middleburity/0.1 (+https://github.com/roryweston26-source/middleburity; student project)";
