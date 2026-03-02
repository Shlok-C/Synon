declare module "wink-lemmatizer" {
  function noun(word: string): string;
  function verb(word: string): string;
  function adjective(word: string): string;
  export { noun, verb, adjective };
}
