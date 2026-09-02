package com.summit.dp.auth.domain.repo;



import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.auth.domain.model.User;


import java.util.Optional;

public interface UserRepository extends RepositoryTemplate<User, Long> {
    Optional<User> findByPhone(String phoneNumber);
}
