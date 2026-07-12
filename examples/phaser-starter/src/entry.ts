if (__APP_TARGET__ === 'reddit') {
  await import('./platform/devvitEntrypoint');
} else {
  await import('./main');
}

export {};
